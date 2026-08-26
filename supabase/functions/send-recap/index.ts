// Supabase Edge Function: send the pro forma recap email.
//
// Providers (checked in this order):
//   1. Microsoft 365 (Graph) — used when ALL of these secrets are set:
//        GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET  (Entra daemon
//        app with Mail.Send application permission), and
//        RECAP_SENDER  (mailbox to send as, e.g. proforma@hometownlend.com)
//      Unset any one of them to fall back to Resend instantly.
//   2. Resend — RESEND_API_KEY, optional RECAP_FROM ("Name <addr>").
//
// Test-mode lock: set RECAP_TEST_ONLY_TO (e.g. james@hometownlend.com) and
// this function will only ever email that address — other recipients get a
// 403, and all BCCs / internal alerts are suppressed. Unset it to go live.
//
// Deploy:   supabase functions deploy send-recap
//
// verify_jwt (on by default) only checks that the bearer token is a validly
// signed project JWT — the public anon key IS one, so this function is
// reachable by anyone with the anon key, signed in or not. The function
// owns the email template (clients send structured numbers, never HTML) and
// rate-limits per recipient below, so it can't be used as an open relay.

import { renderRecapHtml, RecapPayload, CHART_CID, GIF_CID } from "./template.ts";
import { decideSourcingAction, expiryTimestamp, REFERRAL_TOKEN_RE, SourcingRow } from "./sourcing.ts";
import { normalizeEmail, suppressionVerdict } from "./suppression.ts";
import { SYSTEM_PROMPT, buildNarrativePrompt, validateNarrative } from "./narrativePrompt.ts";
import { mintUnsubscribeToken } from "../unsubscribe/token.ts";
import { tierForAnnualVolume } from "./splitTiers.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Optional inline chart: strict standard base64 of a PNG. The base64 of the
// fixed 8-byte PNG signature is a fixed prefix, so this guarantees the bytes
// really are a PNG without decoding — the content_type below can never lie.
// Cap ~2 MB of base64 (~1.5 MB decoded): the real chart is ~50–200 KB, so
// this is generous headroom while keeping an authenticated relay un-abusable.
const CHART_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_B64_PREFIX = "iVBORw0KGgo";
const MAX_CHART_B64_CHARS = 2_000_000;

// Optional vault-hero GIF, same posture: strict base64 whose fixed prefix is
// the base64 of the GIF89a magic bytes — content_type can't lie. 2 MB decoded
// budget (the client enforces the same cap; see src/lib/vaultGif.ts) →
// ~2.8 MB of base64. Graph's whole-message limit is ~4 MB, which the sum of
// caps here (gif 2 MB + chart 1.5 MB + docx 1 MB decoded) can exceed only in
// adversarial payloads — real clients send ~2.2 MB total — and Graph itself
// rejects oversized messages with a 4xx we surface as a provider error.
const GIF_B64_PREFIX = "R0lGODlh"; // = base64("GIF89a") exactly (6 bytes → 8 chars)
const MAX_GIF_B64_CHARS = 2_800_000;

// Optional Word report: a .docx is a ZIP, so the fixed prefix is the base64
// of PK\x03\x04. 1 MB decoded cap — the real report is ~15–40 KB.
const DOCX_B64_PREFIX = "UEsDB";
const MAX_DOCX_B64_CHARS = 1_400_000;

// The Gamma presentation, fetched SERVER-SIDE (never client-supplied) and
// attached as the deliverable the recruit actually opens. A real export measured
// 742 KB; 3 MB is generous headroom while still refusing anything absurd.
const PDF_MAGIC = "%PDF-";
const MAX_PDF_BYTES = 3_000_000;
const DOCUMENTED_PROFORMA_FILENAME = "Documented-Pro-Forma.pdf";
// Total budget for waiting on Gamma. The deck typically completes in ~35-45s.
// Capped well under the Edge Function wall clock so the send itself still has
// room to run; on expiry the email goes out WITHOUT the attachment rather than
// not going out at all.
const PDF_WAIT_MS = 75_000;
const PDF_POLL_INTERVAL_MS = 5_000;
const PRESENTATION_HASH_RE = /^[0-9a-f]{16}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HTL5 referral-sourcing attribution — backend bookkeeping ONLY. Never read
// by RecapPayload/template.ts/RecapView.tsx; the recap recipient never sees
// any of this. First-sender-wins for LO_SOURCING_EXPIRY_DAYS (owner rule:
// the sourcing LO holds the recruit's NMLS for 90 days), after which a new
// send may reassign it — but every reassignment logs an event and fires an
// alert email, so a human reviews it rather than it silently overwriting.
const LO_SOURCING_EXPIRY_DAYS = Number(Deno.env.get("LO_SOURCING_EXPIRY_DAYS") ?? "90");
const LO_SOURCING_ALERT_TO = Deno.env.get("LO_SOURCING_ALERT_TO") || "marketing@hometownlend.com";

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Per-recipient cap. The anon key is public, so this function is reachable
// without signing in (see the note above) — this is the actual abuse guard.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// Every recap is BCC'd here for the team's records (owner-directed address).
// The per-recipient rate limit is keyed on `to` only (see withinRateLimit),
// so this fixed internal BCC never counts against — or is throttled by — a
// recruit's cap.
const BCC_RECIPIENTS = ["chris@utilitypartnersusa.com"];
// Test-mode lock (owner-directed): while RECAP_TEST_ONLY_TO is set, the ONLY
// mailbox this function may email — for any reason — is that address. Recap
// sends addressed to anyone else are refused, and every side email (internal
// BCC, sender copy-back, sourcing/negative-gain alerts) is dropped, so a live
// test can never leak mail to a real recruit or teammate. Unset the secret to
// restore normal delivery.
const TEST_ONLY_TO = (Deno.env.get("RECAP_TEST_ONLY_TO") ?? "").trim().toLowerCase() || null;
// Replies always route to Aryan, whichever mailbox actually sends. Overridable
// via secret so it can change without a code deploy.
const REPLY_TO = Deno.env.get("RECAP_REPLY_TO") || "aryanj@hometownlend.com";
// One-click unsubscribe (RFC 8058). Reliably honored on the Resend path; M365/
// Graph restricts custom internet headers, so on the Graph path the visible
// mailto in the email footer is the compliant unsubscribe mechanism.
const UNSUBSCRIBE_MAILTO = "marketing@hometownlend.com";

/** Signed one-click unsubscribe URL for this recipient, or null when the secret
 *  isn't configured (the footer then falls back to the mailto, as before).
 *  Built from SUPABASE_URL so it needs no separate config. */
const unsubscribeUrlFor = async (email: string): Promise<string | null> => {
  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  const base = Deno.env.get("SUPABASE_URL");
  if (!secret || !base) return null;
  try {
    return `${base}/functions/v1/unsubscribe?t=${encodeURIComponent(await mintUnsubscribeToken(email, secret))}`;
  } catch (e) {
    console.error("unsubscribe URL mint failed (falling back to mailto)", e);
    return null;
  }
};

/** RFC 8058 header pair. One-Click is only legitimate alongside an HTTPS URL —
 *  the previous version declared List-Unsubscribe=One-Click with a mailto only,
 *  which is malformed and may be disregarded outright.
 *
 *  NOTE: Microsoft Graph's internetMessageHeaders only accepts custom `x-*`
 *  names, so it cannot carry List-Unsubscribe at all. On the Graph path the
 *  in-body footer link IS the opt-out mechanism, which is why that link had to
 *  become a real HTTPS one-click URL rather than staying a mailto. */
const unsubscribeHeaders = (httpsUrl: string | null): Record<string, string> =>
  httpsUrl
    ? {
        "List-Unsubscribe": `<${httpsUrl}>, <mailto:${UNSUBSCRIBE_MAILTO}?subject=Unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    // No HTTPS endpoint available: advertise only what actually works.
    : { "List-Unsubscribe": `<mailto:${UNSUBSCRIBE_MAILTO}?subject=Unsubscribe>` };

/** Look up `to` on the opt-out list. The verdict logic (and the FAIL-CLOSED
 *  policy rationale) lives in suppression.ts where vitest can reach it. */
const checkSuppression = async (supabaseUrl: string, serviceKey: string, to: string) => {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/email_suppressions?select=email&email=eq.${encodeURIComponent(normalizeEmail(to))}`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    return suppressionVerdict({ ok: resp.ok, rows: resp.ok ? await resp.json() : null });
  } catch (e) {
    console.error("suppression check failed (fail-CLOSED)", e);
    return suppressionVerdict(null);
  }
};

/** True if `to` is still under the send cap. Fails open on error — a rate-limit outage must never block a legitimate send. */
const withinRateLimit = async (supabaseUrl: string, serviceKey: string, to: string): Promise<boolean> => {
  try {
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/recap_emails?select=id&sent_to=eq.${encodeURIComponent(to)}&created_at=gte.${encodeURIComponent(since)}`,
      { method: "HEAD", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" } },
    );
    const range = resp.headers.get("content-range"); // "0-4/12" or "*/0"
    const count = range ? Number(range.split("/")[1]) : NaN;
    return !Number.isFinite(count) || count < RATE_LIMIT_MAX;
  } catch (e) {
    console.error("rate limit check failed (fail-open)", e);
    return true;
  }
};

// ---- Email providers -------------------------------------------------------

class ProviderError extends Error {
  constructor(public provider: string, public status: number, public detail: string) {
    super(`${provider} rejected the send (${status})`);
  }
}

interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; sender: string }

const graphConfig = (): GraphConfig | null => {
  const tenantId = Deno.env.get("GRAPH_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET");
  const sender = Deno.env.get("RECAP_SENDER");
  return tenantId && clientId && clientSecret && sender ? { tenantId, clientId, clientSecret, sender } : null;
};

// Cached across warm invocations; refreshed 60s before expiry.
let graphToken: { token: string; expiresAt: number } | null = null;

const getGraphToken = async (cfg: GraphConfig): Promise<string> => {
  if (graphToken && graphToken.expiresAt > Date.now()) return graphToken.token;
  const resp = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!resp.ok) throw new ProviderError("Microsoft 365 token", resp.status, await resp.text().catch(() => ""));
  const data = await resp.json();
  graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return graphToken.token;
};

interface RecapAttachments {
  chartPng?: string;
  gif?: string;
  docx?: string;
  /** Base64 Gamma PDF — the "Documented Pro Forma" the recruit receives. */
  pdf?: string;
  /** Signed one-click unsubscribe URL for this recipient. Not an attachment,
   *  but it rides along here because it's per-send and both providers need it
   *  at exactly the point the attachments are assembled. */
  unsubscribeUrl?: string;
}

const sendViaGraph = async (cfg: GraphConfig, to: string, subject: string, html: string, att: RecapAttachments, bcc: string[]): Promise<void> => {
  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    replyTo: [{ emailAddress: { address: REPLY_TO } }],
  };
  if (bcc.length > 0) message.bccRecipients = bcc.map(a => ({ emailAddress: { address: a } }));
  const attachments: Record<string, unknown>[] = [];
  if (att.gif) {
    // Inline CID attachment: contentId matches <img src="cid:..."> in the HTML.
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "your-earnings-animation.gif",
      contentType: "image/gif",
      contentBytes: att.gif,
      contentId: GIF_CID,
      isInline: true,
    });
  }
  if (att.chartPng) {
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "earnings-comparison.png",
      contentType: "image/png",
      contentBytes: att.chartPng,
      contentId: CHART_CID,
      isInline: true,
    });
  }
  if (att.docx) {
    // Regular (non-inline) attachment: the Word report the recipient keeps.
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "proforma-recap.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentBytes: att.docx,
    });
  }
  if (att.pdf) {
    // The deliverable: the recruit opens this, not a link.
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: DOCUMENTED_PROFORMA_FILENAME,
      contentType: "application/pdf",
      contentBytes: att.pdf,
    });
  }
  if (attachments.length > 0) message.attachments = attachments;
  const post = async (token: string) =>
    fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
  let resp = await post(await getGraphToken(cfg));
  if (resp.status === 401) {
    graphToken = null; // stale cached token — refresh once and retry
    resp = await post(await getGraphToken(cfg));
  }
  // Graph success is 202 Accepted with an empty body.
  if (resp.status !== 202) throw new ProviderError("Microsoft 365", resp.status, await resp.text().catch(() => ""));
};

const sendViaResend = async (apiKey: string, to: string, subject: string, html: string, att: RecapAttachments, bcc: string[]): Promise<void> => {
  const from = Deno.env.get("RECAP_FROM") ?? "Hometown Lending <onboarding@resend.dev>";
  const emailBody: Record<string, unknown> = {
    from,
    to: [to],
    subject,
    html,
    reply_to: REPLY_TO,
    headers: {
      ...unsubscribeHeaders(att.unsubscribeUrl ?? null),
    },
  };
  if (bcc.length > 0) emailBody.bcc = bcc;
  const attachments: Record<string, unknown>[] = [];
  if (att.gif) {
    // Inline CID attachments, referenced from the HTML as <img src="cid:...">.
    attachments.push({ content: att.gif, filename: "your-earnings-animation.gif", content_type: "image/gif", content_id: GIF_CID });
  }
  if (att.chartPng) {
    attachments.push({ content: att.chartPng, filename: "earnings-comparison.png", content_type: "image/png", content_id: CHART_CID });
  }
  if (att.docx) {
    attachments.push({
      content: att.docx,
      filename: "proforma-recap.docx",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }
  if (att.pdf) {
    attachments.push({ content: att.pdf, filename: DOCUMENTED_PROFORMA_FILENAME, content_type: "application/pdf" });
  }
  if (attachments.length > 0) emailBody.attachments = attachments;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(emailBody),
  });
  if (!resp.ok) throw new ProviderError("Resend", resp.status, await resp.text().catch(() => ""));
};


/** Chunked base64 — String.fromCharCode(...bytes) blows the call stack on a
 *  700 KB+ buffer, so encode in slices. */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

/**
 * Resolves the recruit's Gamma presentation into an attachable base64 PDF.
 *
 * Why this polls gamma-proxy instead of reading the table directly: there is no
 * background worker anywhere in this system. A recap_presentations row only
 * advances from "processing" to "completed" when gamma-proxy's `status` action
 * runs, so waiting on the table alone would wait forever. gamma-proxy stays the
 * single owner of all Gamma logic; this just drives it and then reads the
 * export URL it stored.
 *
 * Returns null on ANY problem (not ready in time, generation failed, export
 * missing, download failed, not really a PDF, too large). Callers must treat
 * null as "send the email without the attachment" — a recap email going out
 * plain is always better than no email at all.
 */
/** Writes the one personalized opening paragraph via the Claude API.
 *
 *  Best-effort by design, and the failure mode is deliberately boring: every
 *  problem — no API key, HTTP error, timeout, malformed response, or text that
 *  breaks the no-figures rule — returns null, and the email renders without the
 *  paragraph. Nothing downstream depends on it, because every number in the
 *  recap comes from the validated payload instead.
 *
 *  ANTHROPIC_API_KEY unset is the normal "feature off" state, not an error, so
 *  it doesn't log. */
const generateNarrative = async (recap: RecapPayload): Promise<string | null> => {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("NARRATIVE_MODEL") || "claude-sonnet-5",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildNarrativePrompt({
            loName: recap.loName,
            volume: recap.volume,
            files: recap.files,
            // Team payroll is what makes the summary a three-way split rather
            // than a two-way one; same trigger the Gamma deck uses.
            hasTeam: (recap.totals?.brokerPaidTotal ?? 0) > 0,
            selfReported: recap.selfReported === true,
          }),
        }],
      }),
      // Short on purpose: this rides in front of a send the recruit is waiting
      // on. Better a plain email now than a personalized one a minute late.
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      console.error("narrative http", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const data = await resp.json() as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter(b => b?.type === "text")
      .map(b => b.text ?? "")
      .join("")
      .trim();
    // validateNarrative is the enforcement, not the prompt. A model that
    // ignores the brief gets dropped rather than printed.
    const ok = validateNarrative(text);
    if (!ok) console.error("narrative rejected by validator", JSON.stringify(text).slice(0, 200));
    return ok;
  } catch (e) {
    console.error("narrative failed", e);
    return null;
  }
};

const fetchDocumentedProforma = async (
  supabaseUrl: string,
  serviceKey: string,
  hash: string,
): Promise<string | null> => {
  const deadline = Date.now() + PDF_WAIT_MS;
  let exportUrl: string | null = null;

  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/gamma-proxy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", hash }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await r.json().catch(() => null)) as { status?: string } | null;
      const status = body?.status ?? "";
      if (status === "failed" || status === "unknown") {
        console.error("documented proforma unavailable: generation", status);
        return null;
      }
      if (status === "completed") {
        const rows = await fetch(
          `${supabaseUrl}/rest/v1/recap_presentations?recap_hash=eq.${hash}&select=export_url`,
          { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(15_000) },
        ).then(res => (res.ok ? res.json() : null)).catch(() => null);
        exportUrl = Array.isArray(rows) && rows[0]?.export_url ? String(rows[0].export_url) : null;
        break;
      }
    } catch (e) {
      console.error("documented proforma poll failed (will retry until deadline)", e);
    }
    await new Promise(res => setTimeout(res, PDF_POLL_INTERVAL_MS));
  }

  if (!exportUrl) {
    console.error("documented proforma not ready within budget; sending without attachment");
    return null;
  }

  try {
    const r = await fetch(exportUrl, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) {
      console.error("documented proforma download failed:", r.status);
      return null;
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    // Trust nothing from an external host: verify it really is a PDF and that
    // it fits, rather than attaching whatever bytes came back.
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) {
      console.error("documented proforma rejected on size:", buf.length);
      return null;
    }
    if (new TextDecoder().decode(buf.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
      console.error("documented proforma rejected: not a PDF");
      return null;
    }
    return toBase64(buf);
  } catch (e) {
    console.error("documented proforma download threw", e);
    return null;
  }
};

/** UNVERIFIED peek at the bearer JWT's `sub` — used only as a cheap
 *  short-circuit so anonymous sends (whose token is the public anon key,
 *  a valid project JWT with a non-UUID `sub`) skip the Auth roundtrip.
 *  NEVER use this value as an identity: it is attacker-controlled. */
const unverifiedSub = (req: Request): string | null => {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const sub = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null;
    return typeof sub === "string" && UUID_RE.test(sub) ? sub : null;
  } catch {
    return null;
  }
};

/** Resolves the caller's user ID by VERIFYING their bearer token against
 *  Auth (`GET /auth/v1/user`) — never by trusting the JWT payload. HTL5
 *  rev-share attribution hangs off this ID, so a forged token with an
 *  arbitrary UUID `sub` must not be able to claim another LO's recruit.
 *  Best-effort: any failure yields null (an anonymous send), never a
 *  blocked send. */
const verifiedSenderId = async (req: Request, supabaseUrl: string | undefined, serviceKey: string | undefined): Promise<string | null> => {
  if (!unverifiedSub(req)) return null; // anon key / no token — nothing to verify
  if (!supabaseUrl || !serviceKey) return null;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null; // invalid/expired/forged token — treat as anonymous
    const data = await r.json();
    return typeof data?.id === "string" && UUID_RE.test(data.id) ? data.id : null;
  } catch (e) {
    console.error("sender verification failed (non-fatal, treated as anonymous)", e);
    return null;
  }
};

/** Looks up a signed-in sender's email via the Auth Admin API (service role)
 *  so we can BCC them a copy — never trust a client-supplied "my own email"
 *  value. Best-effort: null just means no sender-copy this time. */
const lookupUserEmail = async (supabaseUrl: string, serviceKey: string, userId: string): Promise<string | null> => {
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data?.email === "string" ? data.email : null;
  } catch (e) {
    console.error("sender email lookup failed (non-fatal)", e);
    return null;
  }
};

/** Resolves a recruit-PURL token to the LO who minted it. Best-effort: an
 *  unknown/mistyped token means no attribution, never a blocked send. The
 *  token shape was already validated against REFERRAL_TOKEN_RE. */
const resolveReferralToken = async (url: string, key: string, token: string): Promise<string | null> => {
  try {
    const r = await fetch(
      `${url}/rest/v1/referral_links?token=eq.${encodeURIComponent(token)}&select=created_by`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const id = Array.isArray(rows) && rows[0] ? rows[0].created_by : null;
    if (!id) console.log("referral token unknown — send proceeds unattributed");
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch (e) {
    console.error("referral token lookup failed (non-fatal)", e);
    return null;
  }
};

/** Usage bookkeeping after a successful token-attributed send. Read-then-write
 *  increment: a lost race just undercounts a vanity metric — the claim itself
 *  lives in lo_sourcing, not here. */
const bumpReferralUse = async (url: string, key: string, token: string): Promise<void> => {
  try {
    const r = await fetch(
      `${url}/rest/v1/referral_links?token=eq.${encodeURIComponent(token)}&select=use_count`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
    );
    const rows = r.ok ? await r.json() : null;
    const current = Array.isArray(rows) && rows[0] ? Number(rows[0].use_count) || 0 : 0;
    await fetch(`${url}/rest/v1/referral_links?token=eq.${encodeURIComponent(token)}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ use_count: current + 1, last_used_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("referral use bump failed (non-fatal)", e);
  }
};

const getSourcingRow = async (url: string, key: string, nmls: string): Promise<SourcingRow | null> => {
  try {
    const r = await fetch(
      `${url}/rest/v1/lo_sourcing?nmls=eq.${encodeURIComponent(nmls)}&select=nmls,sourced_by,expires_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? (rows[0] as SourcingRow) : null;
  } catch (e) {
    console.error("lo_sourcing read failed", e);
    return null;
  }
};

const insertSourcingRow = async (url: string, key: string, nmls: string, sourcedBy: string): Promise<void> => {
  try {
    await fetch(`${url}/rest/v1/lo_sourcing`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ nmls, sourced_by: sourcedBy, expires_at: expiryTimestamp(Date.now(), LO_SOURCING_EXPIRY_DAYS) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("lo_sourcing insert failed (non-fatal)", e);
  }
};

/** Reassigns an EXPIRED sourcing row and logs the event — never called for a
 *  still-valid row (that decision is made by decideSourcingAction, not here). */
const reassignSourcingRow = async (
  url: string,
  key: string,
  nmls: string,
  previousSourcedBy: string,
  newSourcedBy: string,
): Promise<void> => {
  try {
    await fetch(`${url}/rest/v1/lo_sourcing?nmls=eq.${encodeURIComponent(nmls)}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        sourced_by: newSourcedBy,
        sourced_at: new Date().toISOString(),
        expires_at: expiryTimestamp(Date.now(), LO_SOURCING_EXPIRY_DAYS),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await fetch(`${url}/rest/v1/lo_sourcing_events`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ nmls, previous_sourced_by: previousSourcedBy, new_sourced_by: newSourcedBy, reason: "expired_reassignment" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("lo_sourcing reassignment failed (non-fatal)", e);
  }
};

/** Fires the human-review alert on a reassignment. Reuses whichever email
 *  provider is already configured — best-effort, never throws. */
const sendSourcingAlert = async (nmls: string, previousSourcedBy: string, newSourcedBy: string): Promise<void> => {
  try {
    if (TEST_ONLY_TO) {
      console.log("test mode: sourcing alert suppressed", { nmls });
      return;
    }
    const graph = graphConfig();
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!graph && !resendKey) return;
    const subject = `LO sourcing reassigned — NMLS ${nmls}`;
    const html = `<p>Sourcing attribution for NMLS <b>${escHtml(nmls)}</b> was reassigned after its expiry window.</p>
      <p>Previous sourcer (user id): ${escHtml(previousSourcedBy)}<br/>New sourcer (user id): ${escHtml(newSourcedBy)}</p>
      <p>This is an automatic alert — please review to confirm this is correct and nobody was taken advantage of.</p>`;
    if (graph) await sendViaGraph(graph, LO_SOURCING_ALERT_TO, subject, html, {}, []);
    else await sendViaResend(resendKey!, LO_SOURCING_ALERT_TO, subject, html, {}, []);
  } catch (e) {
    console.error("sourcing alert send failed (non-fatal)", e);
  }
};

/** Internal heads-up when a recap is withheld because the modeled HTL comp
 *  doesn't beat the recruit's current comp. Sending them "your ceiling just
 *  moved" over a zero/negative gain would be dishonest marketing — the team
 *  gets the numbers instead and decides how to approach. Best-effort. */
const sendNegativeGainAlert = async (recap: RecapPayload, recruitTo: string, gainAnnual: number): Promise<void> => {
  try {
    if (TEST_ONLY_TO) {
      console.log("test mode: negative-gain alert suppressed", { recruitTo });
      return;
    }
    const graph = graphConfig();
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!graph && !resendKey) return;
    const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    const subject = `Recap withheld (no gain) — ${recap.loName || recap.savedName || "unnamed"}${recap.nmls ? ` / NMLS ${recap.nmls}` : ""}`;
    const html = `<p>A pro forma recap was <b>not</b> emailed because the modeled Hometown Lending comp does not beat the recruit's current comp.</p>
      <p>LO: <b>${escHtml(recap.loName || recap.savedName || "—")}</b>${recap.nmls ? ` · NMLS ${escHtml(recap.nmls)}` : ""}<br/>
      Recipient (not sent): ${escHtml(recruitTo)}<br/>
      Current annual: <b>${fmt(recap.current.annual ?? 0)}</b> · HTL annual: <b>${fmt(recap.htl.annual)}</b> · Gain: <b>${fmt(gainAnnual)}</b></p>
      <p>The submission itself was still recorded. This is an automatic internal alert — no email reached the recruit.</p>`;
    if (graph) await sendViaGraph(graph, LO_SOURCING_ALERT_TO, subject, html, {}, []);
    else await sendViaResend(resendKey!, LO_SOURCING_ALERT_TO, subject, html, {}, []);
  } catch (e) {
    console.error("negative-gain alert send failed (non-fatal)", e);
  }
};

/** Is this VERIFIED sender an admin? Used only to let an admin override another
 *  LO's live claim. app_admins is email-keyed, so the sender's address is
 *  resolved through the Auth Admin API rather than taken from the request.
 *
 *  Fails CLOSED: any error returns false. An override is the permissive path, so
 *  a lookup hiccup must deny it rather than hand it out. */
const resolveSenderIsAdmin = async (url: string, key: string, senderId: string): Promise<boolean> => {
  try {
    const email = await lookupUserEmail(url, key, senderId);
    if (!email) return false;
    const resp = await fetch(
      `${url}/rest/v1/app_admins?email=eq.${encodeURIComponent(email.toLowerCase())}&select=email`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return false;
    const rows = await resp.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error("admin lookup failed (treated as non-admin)", e);
    return false;
  }
};

/** Records who sourced this LO, first-sender-wins with a configurable
 *  expiry. Runs AFTER a successful send. Never surfaced to the recipient —
 *  purely backend bookkeeping. */
const recordSourcing = async (supabaseUrl: string, serviceKey: string, nmls: string, senderId: string): Promise<void> => {
  const existing = await getSourcingRow(supabaseUrl, serviceKey, nmls);
  const action = decideSourcingAction(existing, senderId, Date.now());
  if (action.kind === "insert") {
    await insertSourcingRow(supabaseUrl, serviceKey, nmls, senderId);
  } else if (action.kind === "reassign") {
    await reassignSourcingRow(supabaseUrl, serviceKey, nmls, action.previousSourcedBy, senderId);
    await sendSourcingAlert(nmls, action.previousSourcedBy, senderId);
  }
  // Nothing to write for "noop" (same sourcer resending) or "blocked".
  //
  // "blocked" reaching here means the pre-send gate deliberately let this
  // through: an admin overriding someone else's live claim. Leaving the row
  // untouched is the whole point of the override — the send is permitted, the
  // credit stays with whoever earned it. Named explicitly so a future reader
  // doesn't "fix" it into a reassignment.
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const graph = graphConfig();
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!graph && !resendKey) {
    return json(500, { error: "Email isn't configured yet — set the GRAPH_* secrets (Microsoft 365) or RESEND_API_KEY in Supabase." });
  }

  let to = "";
  let recap: RecapPayload;
  let chartPng: string | undefined;
  let gif: string | undefined;
  let docx: string | undefined;
  // Identifies which recap_presentations row holds this recruit's deck. Just an
  // opaque content hash (same hashRecap the client already uses for dedupe), so
  // it is validated by shape only and interpolated into a PostgREST filter --
  // hence the strict 16-hex check rather than trusting the string.
  let presentationHash: string | undefined;
  // Recruit-PURL token (referral_links.token). Same posture as
  // presentationHash: opaque, strictly shaped, PostgREST-filter-bound.
  let referralToken: string | undefined;
  try {
    const body = await req.json();
    to = String(body.to ?? "").trim();
    recap = body.recap as RecapPayload;
    if (!EMAIL_RE.test(to)) return json(400, { error: "Invalid recipient email address." });
    if (TEST_ONLY_TO && normalizeEmail(to) !== TEST_ONLY_TO) {
      return json(403, { error: `Test mode: recaps can only be sent to ${TEST_ONLY_TO} right now.` });
    }
    // Validate the FULL shape the template dereferences — not just two fields.
    // renderRecapHtml reads recap.current/gain/buckets/totals unconditionally;
    // a partial payload that slipped past a two-field check would throw at
    // render time (outside any try) → an ungraceful platform 500 with no CORS.
    // The numeric checks also close an HTML-injection hole: loSplit/currentBps
    // are interpolated into the email, so a string here is markup.
    // (holdbackPct and totals.teamHoldback are RETIRED payload keys — the
    // holdback became a derived internal metric and no longer travels.)
    const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
    const isNumOrNull = (v: unknown) => v == null || isNum(v);
    if (
      !recap ||
      typeof recap.savedName !== "string" ||
      !recap.htl || !isNum(recap.htl.annual) || !isNum(recap.htl.monthly) ||
      !recap.current || !isNumOrNull(recap.current.annual) || !isNumOrNull(recap.current.monthly) ||
      !recap.gain || !isNumOrNull(recap.gain.annual) || !isNumOrNull(recap.gain.monthly) ||
      !isNum(recap.loSplit) || !isNumOrNull(recap.currentBps) ||
      !isNumOrNull(recap.volume) || !isNumOrNull(recap.files) || !isNumOrNull(recap.avgLoan) ||
      !Array.isArray(recap.buckets) ||
      !recap.buckets.every(b => b && typeof b.label === "string" && isNum(b.compPct)) ||
      !recap.totals ||
      ![recap.totals.loNetBeforeHoldback, recap.totals.brokerPaidTotal, recap.totals.finalLoNetComp].every(isNumOrNull)
    ) {
      return json(400, { error: "Invalid recap payload." });
    }
    // Binary artifacts ride beside recap, never inside it — the only
    // legitimate producer is our client, so anything malformed is a hard 400
    // (matching the posture on `to`/`recap`), not a silently degraded email.
    // Each is verified by size cap + strict base64 + magic-byte prefix, so
    // the declared content types below can never lie about the bytes.
    const validB64 = (raw: unknown, maxChars: number, magicPrefix: string): raw is string =>
      typeof raw === "string" &&
      raw.length > 0 &&
      raw.length <= maxChars &&
      raw.length % 4 === 0 &&
      CHART_B64_RE.test(raw) &&
      raw.startsWith(magicPrefix);

    if (body.chartPng != null) {
      if (!validB64(body.chartPng, MAX_CHART_B64_CHARS, PNG_B64_PREFIX)) return json(400, { error: "Invalid chart image data." });
      chartPng = body.chartPng;
    }
    if (body.gif != null) {
      if (!validB64(body.gif, MAX_GIF_B64_CHARS, GIF_B64_PREFIX)) return json(400, { error: "Invalid animation data." });
      gif = body.gif;
    }
    if (body.docx != null) {
      if (!validB64(body.docx, MAX_DOCX_B64_CHARS, DOCX_B64_PREFIX)) return json(400, { error: "Invalid report attachment data." });
      docx = body.docx;
    }
    if (body.presentationHash != null) {
      const h = String(body.presentationHash);
      if (!PRESENTATION_HASH_RE.test(h)) return json(400, { error: "Invalid presentation reference." });
      presentationHash = h;
    }
    if (body.referralToken != null) {
      const t = String(body.referralToken);
      if (!REFERRAL_TOKEN_RE.test(t)) return json(400, { error: "Invalid referral link." });
      referralToken = t;
    }
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Resolved here (not at the sender-copy-back block below) because the
  // suppressed-send audit row also records who attempted the send. Verified
  // against Auth — attribution money hangs off this ID (see verifiedSenderId).
  const senderId = await verifiedSenderId(req, supabaseUrl, serviceKey);
  // HTL5 attribution identity: the signed-in sender when there is one,
  // otherwise the creator of the recruit's PURL (link use = claim, owner
  // rule). senderId keeps its own meaning everywhere else — audit rows and
  // the copy-back BCC stay keyed on who actually pressed send.
  const referralCreatorId =
    !senderId && referralToken && supabaseUrl && serviceKey
      ? await resolveReferralToken(supabaseUrl, serviceKey, referralToken)
      : null;
  const attributedId = senderId ?? referralCreatorId;

  // Opt-out check FIRST — a suppressed address must never be emailed again,
  // whoever asks (CAN-SPAM: opt-outs are permanent until the person opts back
  // in). Keyed on the recruit `to` only; the fixed internal BCCs are ours.
  if (supabaseUrl && serviceKey) {
    const verdict = await checkSuppression(supabaseUrl, serviceKey, to);
    if (verdict === "unavailable") {
      // Fail CLOSED (see suppression.ts): refuse retryably rather than risk
      // emailing someone who opted out.
      return json(503, { error: "Couldn't verify this address is okay to email. Try again in a moment." });
    }
    if (verdict === "suppressed") {
      // Clean non-send, recorded in the audit trail so the team can see WHY
      // nothing arrived. 200 + marker (not an opaque error): the client
      // surfaces an honest "this address has unsubscribed" message.
      try {
        await fetch(`${supabaseUrl}/rest/v1/recap_emails`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ sent_to: to, sent_by: senderId, status: "suppressed", payload: null }),
        });
      } catch (e) {
        console.error("suppressed-send audit log failed (non-fatal)", e);
      }
      return json(200, { ok: true, suppressed: true });
    }
  }

  if (supabaseUrl && serviceKey && !(await withinRateLimit(supabaseUrl, serviceKey, to))) {
    return json(429, { error: "Too many recap emails sent to this address recently. Try again in a bit." });
  }

  // Zero/negative-gain guard — SERVER-side and recomputed from the raw
  // figures (never trusting the client's recap.gain), so no client can
  // accidentally send a "your ceiling just moved" email over a number that
  // moved down. No BPS entered (current.annual == null) means there is no
  // comparison to lose — those send normally.
  const gainAnnual = recap.current.annual != null ? recap.htl.annual - recap.current.annual : null;
  if (gainAnnual != null && gainAnnual <= 0) {
    await sendNegativeGainAlert(recap, to, gainAnnual);
    if (supabaseUrl && serviceKey) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/recap_emails`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ sent_to: to, sent_by: senderId, status: "negative_gain", payload: null }),
        });
      } catch (e) {
        console.error("negative-gain audit log failed (non-fatal)", e);
      }
    }
    return json(200, { ok: true, suppressed: "negative_gain" });
  }

  // Split gate. The UI only shows the 80/85/90 override to admins, but UI
  // gating is chrome (CLAUDE.md): this function runs verify_jwt=false and the
  // anon key ships in the bundle, so the payload's loSplit is attacker-chosen.
  // Recompute the band the volume actually earns and refuse a better claimed
  // split from anyone but a VERIFIED admin. A worse-than-earned split is always
  // allowed — quoting below band harms nobody and needs no privilege.
  //
  // Refuse rather than clamp: silently downgrading would email the recruit
  // different numbers than the sender saw on screen, which is worse than a
  // clear error. All the payload's comp figures were computed client-side at
  // the claimed split, so no honest email exists to salvage here.
  let splitOverrideBy: string | null = null;
  {
    // Same annualization as calculate(): a 6-month $15M pull is a $30M/yr pace.
    const months = typeof recap.periodMonths === "number" && recap.periodMonths > 0 ? recap.periodMonths : 12;
    const derived = tierForAnnualVolume((recap.volume ?? 0) * (12 / months)).loPct;
    if (recap.loSplit > derived) {
      const senderIsAdmin = senderId && supabaseUrl && serviceKey
        ? await resolveSenderIsAdmin(supabaseUrl, serviceKey, senderId)
        : false;
      if (!senderIsAdmin) {
        console.warn(`split gate: refused ${recap.loSplit}% on volume earning ${derived}% (sender ${senderId ?? "anonymous"})`);
        return json(403, {
          error: "split_not_earned",
          message: `A ${recap.loSplit}/${100 - recap.loSplit} split needs an admin — this volume qualifies for ${derived}/${100 - derived} under the published tiers.`,
          derivedSplit: derived,
        });
      }
      splitOverrideBy = senderId;
      console.log(`split gate: admin ${senderId} overrode ${derived}% -> ${recap.loSplit}%`);
    }
  }

  // HTL5 claim gate. Sits with the other refuse-to-send guards, BEFORE the
  // Graph call, because recordSourcing runs after the send and is explicitly
  // forbidden from blocking it — a stop has to happen here or not at all.
  //
  // Keyed on senderId (a verified, signed-in team member), NOT attributedId:
  // attributedId is also set when a recruit self-serves through an LO's PURL,
  // and a recruit must never be denied their own pro forma because a colleague
  // holds the claim. Anonymous and PURL sends therefore skip this entirely.
  if (senderId && supabaseUrl && serviceKey && typeof recap.nmls === "string" && recap.nmls.trim()) {
    const nmls = recap.nmls.trim();
    try {
      const existing = await getSourcingRow(supabaseUrl, serviceKey, nmls);
      const senderIsAdmin = existing && existing.sourced_by !== senderId
        ? await resolveSenderIsAdmin(supabaseUrl, serviceKey, senderId)
        : false; // only worth a round-trip when an override could actually apply
      const decision = decideSourcingAction(existing, senderId, Date.now(), { senderIsAdmin });
      if (decision.kind === "blocked") {
        const holder = (await lookupUserEmail(supabaseUrl, serviceKey, decision.claimedBy))
          ?? decision.claimedBy.slice(0, 8);
        console.log(`send blocked: ${nmls} claimed by ${decision.claimedBy} until ${decision.expiresAt}`);
        // 409 Conflict: the request is well-formed, it collides with existing
        // state. No email is sent and no claim is written.
        return json(409, {
          error: "already_claimed",
          message: `This NMLS is already sourced by ${holder} until ${new Date(decision.expiresAt).toLocaleDateString("en-US")}. Ask an admin if you need to send anyway.`,
          claimedBy: holder,
          expiresAt: decision.expiresAt,
        });
      }
    } catch (e) {
      // Fail OPEN on an infrastructure error: a claim-lookup outage must not
      // stop legitimate recruiting. The worst case is the old behaviour —
      // the send goes out and recordSourcing sorts the credit out after.
      console.error("claim gate check failed (send allowed)", e);
    }
  }

  const subject = `Your Pro Forma Recap${recap.loName ? ` — ${recap.loName}` : ""} | Hometown Lending`;
  // BOOKING_URL secret (Microsoft Bookings page) turns on the "Book a
  // recruiting call" button in the email; unset = button omitted.
  const bookingUrl = Deno.env.get("BOOKING_URL") || undefined;
  const appOrigin = Deno.env.get("APP_ORIGIN") || undefined;

  // The Gamma deck rides along as a PDF attachment. Resolved BEFORE rendering
  // so the closing "Documented Pro Forma" block is only written into the HTML
  // when a file is genuinely attached — the email must never name an
  // attachment the recipient can't find. A null here degrades to a plain
  // recap email; it never blocks the send.
  let pdf: string | undefined;
  if (presentationHash && supabaseUrl && serviceKey) {
    pdf = (await fetchDocumentedProforma(supabaseUrl, serviceKey, presentationHash)) ?? undefined;
  }

  // One personalized opening paragraph. Best-effort, exactly like the chart,
  // the GIF, the docx and the Gamma PDF above: a model hiccup must never keep a
  // recap from reaching a recruit, so every failure path just leaves it out.
  // It carries no figures by construction — see narrativePrompt.ts.
  const narrative = await generateNarrative(recap);

  // Why the recipient got this, stated honestly in the footer. A verified
  // senderId with no referral token means a signed-in LO pushed it out
  // unprompted; anything else means the recipient drove it themselves (public
  // self-serve, or choosing to open an LO's PURL).
  const origin: "requested" | "recruiter" = senderId && !referralToken ? "recruiter" : "requested";
  const unsubscribeUrl = (await unsubscribeUrlFor(to)) ?? undefined;

  const html = renderRecapHtml({ ...recap, ...(narrative ? { narrative } : {}) }, {
    origin,
    ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
    ...(chartPng ? { chartCid: CHART_CID } : {}),
    bookingUrl,
    appOrigin,
    ...(pdf ? { documentedProformaName: DOCUMENTED_PROFORMA_FILENAME } : {}),
  });

  const attachments = { chartPng, gif, docx, pdf, ...(unsubscribeUrl ? { unsubscribeUrl } : {}) };
  // Sender-copy-back: a signed-in team member automatically gets a BCC copy
  // of what they just sent — an automatic record with no manual CC needed.
  // Looked up server-side from their auth session, never client-supplied.
  // Anonymous/public sends have no signed-in sender, so this naturally
  // no-ops. (senderId itself is decoded earlier, beside the suppression
  // check, which also records it.)
  let senderEmail: string | null = null;
  if (senderId && supabaseUrl && serviceKey) {
    senderEmail = await lookupUserEmail(supabaseUrl, serviceKey, senderId);
  } else if (referralCreatorId && supabaseUrl && serviceKey) {
    // Recruit self-served through an LO's PURL — no signed-in sender, but the
    // referring LO still gets a copy of what was sent to their recruit (owner
    // rule: both parties receive the email on every path).
    senderEmail = await lookupUserEmail(supabaseUrl, serviceKey, referralCreatorId);
  }
  // Never BCC an address that's already the primary recipient (e.g. a test
  // send straight to marketing, or someone emailing their own recap) — that
  // would double-deliver.
  const bcc = TEST_ONLY_TO
    ? [] // test mode: nobody but the test address gets a copy
    : [...BCC_RECIPIENTS, ...(senderEmail ? [senderEmail] : [])].filter(
        (a, i, arr) => a.toLowerCase() !== to.toLowerCase() && arr.indexOf(a) === i,
      );
  try {
    if (graph) await sendViaGraph(graph, to, subject, html, attachments, bcc);
    else await sendViaResend(resendKey!, to, subject, html, attachments, bcc);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(e.provider, "error", e.status, e.detail);
      return json(502, { error: `Email provider rejected the send (${e.status}).` });
    }
    throw e;
  }

  // Log the send with the service role (RLS has no client insert policy).
  try {
    if (supabaseUrl && serviceKey) {
      // Client-supplied artifacts in the email are recorded by fingerprint
      // (hash + size) — never the bytes.
      const fingerprint = async (b64?: string): Promise<{ sha256: string; bytes: number } | null> => {
        if (!b64) return null;
        try {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
          return { sha256, bytes: bytes.length };
        } catch {
          return null; // best effort — never blocks the log
        }
      };
      const chart = await fingerprint(chartPng);
      const gifMeta = await fingerprint(gif);
      const docxMeta = await fingerprint(docx);
      const logResp = await fetch(`${supabaseUrl}/rest/v1/recap_emails`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        // Numbers only in the audit log — never image/attachment bytes. The
        // defensive spread also strips artifacts a buggy client might nest in
        // recap. proforma_id is nulled unless it's a real UUID: a junk value
        // would make Postgres reject the row, silently skipping the audit trail.
        body: JSON.stringify({
          proforma_id: UUID_RE.test(recap.proformaId ?? "") ? recap.proformaId : null,
          sent_to: to,
          sent_by: senderId,
          payload: { ...recap, chartPng: undefined, gif: undefined, docx: undefined, chart, gifMeta, docxMeta },
        }),
      });
      if (!logResp.ok) console.error("recap_emails log failed", logResp.status, await logResp.text().catch(() => ""));
    }
  } catch (e) {
    console.error("recap_emails log failed (non-fatal)", e);
  }

  // Split-override audit: stamp WHO granted the non-standard split onto the
  // proforma row, service-role and post-send only — the client's split_source
  // is display, this is the trusted record. Best-effort like the rest of the
  // tail: the email already went, bookkeeping must not surface a failure.
  if (splitOverrideBy && supabaseUrl && serviceKey && UUID_RE.test(recap.proformaId ?? "")) {
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/proformas?id=eq.${encodeURIComponent(recap.proformaId!)}`, {
        method: "PATCH",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ split_source: "override", split_overridden_by: splitOverrideBy }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) console.error("split audit write failed", resp.status, await resp.text().catch(() => ""));
    } catch (e) {
      console.error("split audit write failed (non-fatal)", e);
    }
  }

  // HTL5 referral-sourcing: a signed-in team member's send, or a recruit
  // self-serving through an LO's PURL (attributedId resolves either way).
  // Best-effort — a bookkeeping hiccup must never surface to the recipient
  // or block the send that already succeeded above.
  if (attributedId && supabaseUrl && serviceKey && typeof recap.nmls === "string" && recap.nmls.trim()) {
    try {
      await recordSourcing(supabaseUrl, serviceKey, recap.nmls.trim(), attributedId);
    } catch (e) {
      console.error("lo_sourcing recording failed (non-fatal)", e);
    }
  }
  // Track link usage only when the token actually carried the attribution.
  if (referralCreatorId && referralToken && supabaseUrl && serviceKey) {
    await bumpReferralUse(supabaseUrl, serviceKey, referralToken);
  }

  return json(200, { ok: true });
});
