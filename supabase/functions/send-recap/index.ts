// Supabase Edge Function: send the pro forma recap email via Resend.
//
// Deploy:   supabase functions deploy send-recap
// Secrets:  supabase secrets set RESEND_API_KEY=re_...
//           supabase secrets set RECAP_FROM="Hometown Lending <proforma@hometownlend.com>"  (optional)
//
// Called with the user's JWT (verify_jwt is on by default), so only
// signed-in users can send. The function owns the email template — clients
// send structured numbers, never HTML, so this can't be used as an open relay.

import { renderRecapHtml, RecapPayload, CHART_CID } from "./template.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json(500, { error: "Email isn't configured yet — set the RESEND_API_KEY secret in Supabase." });

  let to = "";
  let recap: RecapPayload;
  let chartPng: string | undefined;
  try {
    const body = await req.json();
    to = String(body.to ?? "").trim();
    recap = body.recap as RecapPayload;
    if (!EMAIL_RE.test(to)) return json(400, { error: "Invalid recipient email address." });
    if (!recap || typeof recap.htl?.annual !== "number" || typeof recap.savedName !== "string") {
      return json(400, { error: "Invalid recap payload." });
    }
    // chartPng rides beside recap, never inside it — the only legitimate
    // producer is our client, so anything malformed is a hard 400 (matching
    // the posture on `to`/`recap`), not a silently degraded email.
    const rawChart = body.chartPng;
    if (rawChart != null) {
      if (typeof rawChart !== "string" || rawChart.length > MAX_CHART_B64_CHARS) {
        return json(400, { error: "Chart image too large or malformed." });
      }
      if (rawChart.length === 0 || rawChart.length % 4 !== 0 || !CHART_B64_RE.test(rawChart) || !rawChart.startsWith(PNG_B64_PREFIX)) {
        return json(400, { error: "Invalid chart image data." });
      }
      chartPng = rawChart;
    }
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const from = Deno.env.get("RECAP_FROM") ?? "Hometown Lending <onboarding@resend.dev>";
  const subject = `Your Pro Forma Recap${recap.loName ? ` — ${recap.loName}` : ""} | Hometown Lending`;
  const html = renderRecapHtml(recap, chartPng ? { chartCid: CHART_CID } : {});

  const emailBody: Record<string, unknown> = { from, to: [to], subject, html };
  if (chartPng) {
    // Inline CID attachment, referenced from the HTML as <img src="cid:...">.
    emailBody.attachments = [
      { content: chartPng, filename: "earnings-comparison.png", content_type: "image/png", content_id: CHART_CID },
    ];
  }

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(emailBody),
  });

  if (!resendResp.ok) {
    const detail = await resendResp.text().catch(() => "");
    console.error("Resend error", resendResp.status, detail);
    return json(502, { error: `Email provider rejected the send (${resendResp.status}).` });
  }

  // Log the send with the service role (RLS has no client insert policy).
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && serviceKey) {
      // The chart is the one client-supplied artifact in the email, so the
      // audit row records its fingerprint (hash + size) — never the bytes.
      let chart: { sha256: string; bytes: number } | null = null;
      if (chartPng) {
        try {
          const bytes = Uint8Array.from(atob(chartPng), c => c.charCodeAt(0));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
          chart = { sha256, bytes: bytes.length };
        } catch { /* best effort — never blocks the log */ }
      }
      // sent_by from the caller's JWT payload (already verified by the platform).
      let sentBy: string | null = null;
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const parts = token.split(".");
      if (parts.length === 3) {
        try { sentBy = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null; } catch { /* best effort */ }
      }
      await fetch(`${supabaseUrl}/rest/v1/recap_emails`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        // Numbers only in the audit log — never image bytes. The defensive
        // spread also strips a chartPng a buggy client might nest in recap.
        body: JSON.stringify({ proforma_id: recap.proformaId ?? null, sent_to: to, sent_by: sentBy, payload: { ...recap, chartPng: undefined, chart } }),
      });
    }
  } catch (e) {
    console.error("recap_emails log failed (non-fatal)", e);
  }

  return json(200, { ok: true });
});
