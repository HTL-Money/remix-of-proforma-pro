// Supabase Edge Function: send the pro forma recap email via Resend.
//
// Deploy:   supabase functions deploy send-recap
// Secrets:  supabase secrets set RESEND_API_KEY=re_...
//           supabase secrets set RECAP_FROM="Hometown Lending <proforma@hometownlend.com>"  (optional)
//
// Called with the user's JWT (verify_jwt is on by default), so only
// signed-in users can send. The function owns the email template — clients
// send structured numbers, never HTML, so this can't be used as an open relay.

import { renderRecapHtml, RecapPayload } from "./template.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json(500, { error: "Email isn't configured yet — set the RESEND_API_KEY secret in Supabase." });

  let to = "";
  let recap: RecapPayload;
  try {
    const body = await req.json();
    to = String(body.to ?? "").trim();
    recap = body.recap as RecapPayload;
    if (!EMAIL_RE.test(to)) return json(400, { error: "Invalid recipient email address." });
    if (!recap || typeof recap.htl?.annual !== "number" || typeof recap.savedName !== "string") {
      return json(400, { error: "Invalid recap payload." });
    }
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const from = Deno.env.get("RECAP_FROM") ?? "Hometown Lending <onboarding@resend.dev>";
  const subject = `Your Pro Forma Recap${recap.loName ? ` — ${recap.loName}` : ""} | Hometown Lending`;
  const html = renderRecapHtml(recap);

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
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
        body: JSON.stringify({ proforma_id: recap.proformaId ?? null, sent_to: to, sent_by: sentBy, payload: recap }),
      });
    }
  } catch (e) {
    console.error("recap_emails log failed (non-fatal)", e);
  }

  return json(200, { ok: true });
});
