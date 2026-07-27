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
// Deploy:   supabase functions deploy send-recap
//
// verify_jwt (on by default) only checks that the bearer token is a validly
// signed project JWT — the public anon key IS one, so this function is
// reachable by anyone with the anon key, signed in or not. The function
// owns the email template (clients send structured numbers, never HTML) and
// rate-limits per recipient below, so it can't be used as an open relay.

import { renderRecapHtml, RecapPayload, CHART_CID, GIF_CID } from "./template.ts";
import { decideSourcingAction, expiryTimestamp, SourcingRow } from "./sourcing.ts";

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
// any of this. First-sender-wins for LO_SOURCING_EXPIRY_MONTHS, after which a
// new send may reassign it — but every reassignment logs an event and fires
// an alert email, so a human reviews it rather than it silently overwriting.
const LO_SOURCING_EXPIRY_MONTHS = Number(Deno.env.get("LO_SOURCING_EXPIRY_MONTHS") ?? "12");
const LO_SOURCING_ALERT_TO = Deno.env.get("LO_SOURCING_ALERT_TO") || "marketing@hometownlend.com";

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Per-recipient cap. The anon key is public, so this function is reachable
// without signing in (see the note above) — this is the actual abuse guard.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// Every recap is BCC'd to marketing for the team's records. The per-recipient
// rate limit is keyed on `to` only (see withinRateLimit), so this fixed
// internal BCC never counts against — or is throttled by — a recruit's cap.
const BCC_RECIPIENTS = ["marketing@hometownlend.com"];
// Replies always route to Aryan, whichever mailbox actually sends. Overridable
// via secret so it can change without a code deploy.
const REPLY_TO = Deno.env.get("RECAP_REPLY_TO") || "aryanj@hometownlend.com";
// One-click unsubscribe (RFC 8058). Reliably honored on the Resend path; M365/
// Graph restricts custom internet headers, so on the Graph path the visible
// mailto in the email footer is the compliant unsubscribe mechanism.
const UNSUBSCRIBE_MAILTO = "marketing@hometownlend.com";

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
      "List-Unsubscribe": `<mailto:${UNSUBSCRIBE_MAILTO}?subject=Unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
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

/** Best-effort: extracts the caller's user ID from their bearer JWT's `sub`
 *  claim, but ONLY if it's a real UUID — the public anon key is itself a
 *  valid JWT (see the file-header note), and its `sub` is not a real
 *  auth.users id, so this naturally no-ops for anonymous/public sends. */
const extractSenderId = (req: Request): string | null => {
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
      body: JSON.stringify({ nmls, sourced_by: sourcedBy, expires_at: expiryTimestamp(Date.now(), LO_SOURCING_EXPIRY_MONTHS) }),
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
        expires_at: expiryTimestamp(Date.now(), LO_SOURCING_EXPIRY_MONTHS),
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
  // "noop" — either the same sourcer sent again, or the row is still within
  // its expiry window (protects the original recruiter from being overwritten).
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
  try {
    const body = await req.json();
    to = String(body.to ?? "").trim();
    recap = body.recap as RecapPayload;
    if (!EMAIL_RE.test(to)) return json(400, { error: "Invalid recipient email address." });
    // Validate the FULL shape the template dereferences — not just two fields.
    // renderRecapHtml reads recap.current/gain/buckets/totals unconditionally;
    // a partial payload that slipped past a two-field check would throw at
    // render time (outside any try) → an ungraceful platform 500 with no CORS.
    // The numeric checks also close an HTML-injection hole: loSplit/holdbackPct/
    // currentBps are interpolated into the email, so a string here is markup.
    const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
    const isNumOrNull = (v: unknown) => v == null || isNum(v);
    if (
      !recap ||
      typeof recap.savedName !== "string" ||
      !recap.htl || !isNum(recap.htl.annual) || !isNum(recap.htl.monthly) ||
      !recap.current || !isNumOrNull(recap.current.annual) || !isNumOrNull(recap.current.monthly) ||
      !recap.gain || !isNumOrNull(recap.gain.annual) || !isNumOrNull(recap.gain.monthly) ||
      !isNum(recap.loSplit) || !isNum(recap.holdbackPct) || !isNumOrNull(recap.currentBps) ||
      !isNumOrNull(recap.volume) || !isNumOrNull(recap.files) || !isNumOrNull(recap.avgLoan) ||
      !Array.isArray(recap.buckets) ||
      !recap.buckets.every(b => b && typeof b.label === "string" && isNum(b.compPct)) ||
      !recap.totals ||
      ![recap.totals.loNetBeforeHoldback, recap.totals.teamHoldback, recap.totals.brokerPaidTotal, recap.totals.finalLoNetComp].every(isNumOrNull)
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
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl && serviceKey && !(await withinRateLimit(supabaseUrl, serviceKey, to))) {
    return json(429, { error: "Too many recap emails sent to this address recently. Try again in a bit." });
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

  const html = renderRecapHtml(recap, {
    ...(chartPng ? { chartCid: CHART_CID } : {}),
    bookingUrl,
    appOrigin,
    ...(pdf ? { documentedProformaName: DOCUMENTED_PROFORMA_FILENAME } : {}),
  });

  const attachments = { chartPng, gif, docx, pdf };
  // Sender-copy-back: a signed-in team member automatically gets a BCC copy
  // of what they just sent — an automatic record with no manual CC needed.
  // Looked up server-side from their auth session, never client-supplied.
  // Anonymous/public sends have no signed-in sender, so this naturally no-ops.
  const senderId = extractSenderId(req);
  let senderEmail: string | null = null;
  if (senderId && supabaseUrl && serviceKey) {
    senderEmail = await lookupUserEmail(supabaseUrl, serviceKey, senderId);
  }
  // Never BCC an address that's already the primary recipient (e.g. a test
  // send straight to marketing, or someone emailing their own recap) — that
  // would double-deliver.
  const bcc = [...BCC_RECIPIENTS, ...(senderEmail ? [senderEmail] : [])].filter(
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

  // HTL5 referral-sourcing: only for a signed-in team member sending to a
  // real NMLS. Best-effort — a bookkeeping hiccup must never surface to the
  // recipient or block the send that already succeeded above.
  if (senderId && supabaseUrl && serviceKey && typeof recap.nmls === "string" && recap.nmls.trim()) {
    try {
      await recordSourcing(supabaseUrl, serviceKey, recap.nmls.trim(), senderId);
    } catch (e) {
      console.error("lo_sourcing recording failed (non-fatal)", e);
    }
  }

  return json(200, { ok: true });
});
