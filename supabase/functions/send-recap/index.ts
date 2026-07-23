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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-recipient cap. The anon key is public, so this function is reachable
// without signing in (see the note above) — this is the actual abuse guard.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
}

const sendViaGraph = async (cfg: GraphConfig, to: string, subject: string, html: string, att: RecapAttachments): Promise<void> => {
  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
  };
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

const sendViaResend = async (apiKey: string, to: string, subject: string, html: string, att: RecapAttachments): Promise<void> => {
  const from = Deno.env.get("RECAP_FROM") ?? "Hometown Lending <onboarding@resend.dev>";
  const emailBody: Record<string, unknown> = { from, to: [to], subject, html };
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
  if (attachments.length > 0) emailBody.attachments = attachments;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(emailBody),
  });
  if (!resp.ok) throw new ProviderError("Resend", resp.status, await resp.text().catch(() => ""));
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
  try {
    const body = await req.json();
    to = String(body.to ?? "").trim();
    recap = body.recap as RecapPayload;
    if (!EMAIL_RE.test(to)) return json(400, { error: "Invalid recipient email address." });
    if (!recap || typeof recap.htl?.annual !== "number" || typeof recap.savedName !== "string") {
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
  const html = renderRecapHtml(recap, {
    ...(chartPng ? { chartCid: CHART_CID } : {}),
    ...(gif ? { gifCid: GIF_CID } : {}),
    bookingUrl,
  });

  const attachments = { chartPng, gif, docx };
  try {
    if (graph) await sendViaGraph(graph, to, subject, html, attachments);
    else await sendViaResend(resendKey!, to, subject, html, attachments);
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
      // sent_by from the caller's JWT payload (already verified by the platform).
      let sentBy: string | null = null;
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const parts = token.split(".");
      if (parts.length === 3) {
        try { sentBy = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null; } catch { /* best effort */ }
      }
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
          sent_by: sentBy,
          payload: { ...recap, chartPng: undefined, gif: undefined, docx: undefined, chart, gifMeta, docxMeta },
        }),
      });
      if (!logResp.ok) console.error("recap_emails log failed", logResp.status, await logResp.text().catch(() => ""));
    }
  } catch (e) {
    console.error("recap_emails log failed (non-fatal)", e);
  }

  return json(200, { ok: true });
});
