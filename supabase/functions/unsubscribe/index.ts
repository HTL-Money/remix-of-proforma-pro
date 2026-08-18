// One-click unsubscribe endpoint.
//
// Exists because send-recap was declaring `List-Unsubscribe-Post:
// List-Unsubscribe=One-Click` while offering only a `mailto:` — one-click POST
// requires an HTTPS endpoint, so that header pair was malformed. Mailbox
// providers may disregard it, and it advertised a capability that didn't exist.
//
// It also closes the process gap behind it: opt-outs used to land in a
// human-monitored inbox and be honoured by hand-written SQL (email_suppressions
// had zero rows). CAN-SPAM allows 10 business days, but "a person reads that
// inbox" is not a control you can evidence. Now a click writes the suppression
// itself, immediately and with an audit trail.
//
// MUST be deployed with verify_jwt = false: the caller is a mail provider or a
// recipient's browser, neither of which carries a session. The signed token in
// the URL is the authorisation — see token.ts.
import { verifyUnsubscribeToken } from "./token.ts";

// Same local declaration the other functions use — the Deno types aren't
// available to the repo's tsc invocation, only to the deploy runtime.
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Always the same page, whatever happened. A recipient who clicks unsubscribe
 *  should never be told "invalid token" — that reads as "we're still going to
 *  email you", and it leaks whether an address is on file. */
const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title></head>
<body style="margin:0;background:#13294B;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
<div style="max-width:520px;margin:12vh auto;padding:32px 28px;background:#fff;border-radius:12px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#13294B;">${title}</h1>
<p style="margin:0;color:#4a4a4a;font-size:15px;line-height:1.6;">${body}</p>
</div></body></html>`,
    { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } },
  );

const suppress = async (email: string, source: string): Promise<boolean> => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("unsubscribe: storage not configured");
    return false;
  }
  const resp = await fetch(`${url}/rest/v1/email_suppressions`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Idempotent: a provider may POST once and the human click again. A
      // repeat opt-out is a success, not a duplicate-key error.
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ email, source }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) console.error("unsubscribe: insert failed", resp.status, await resp.text().catch(() => ""));
  return resp.ok;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  if (!secret) {
    console.error("unsubscribe: UNSUBSCRIBE_SECRET unset — cannot verify tokens");
    return page("Something went wrong", "We couldn't process that just now. Email marketing@hometownlend.com and we'll remove you by hand.");
  }

  // Token may arrive as ?t= (our footer link) or in a POSTed form body, which is
  // what RFC 8058 one-click clients send.
  const url = new URL(req.url);
  let token = url.searchParams.get("t") ?? "";
  if (!token && req.method === "POST") {
    try {
      const raw = await req.text();
      token = new URLSearchParams(raw).get("t") ?? raw.trim();
    } catch { /* fall through to the invalid-token path */ }
  }

  const email = await verifyUnsubscribeToken(token, secret);
  if (!email) {
    // Deliberately indistinguishable from success to the person reading it.
    console.warn("unsubscribe: invalid or missing token");
    return page("You're unsubscribed", "You won't receive further pro forma emails from Hometown Lending. If anything still arrives, reply to it and we'll sort it out.");
  }

  const ok = await suppress(email, req.method === "POST" ? "one-click-post" : "one-click-link");
  console.log(`unsubscribe: ${ok ? "suppressed" : "FAILED"} ${email} via ${req.method}`);
  return page(
    "You're unsubscribed",
    ok
      ? `<strong>${email}</strong> has been removed. You won't receive further pro forma emails from Hometown Lending.`
      : "We've recorded your request. If anything still arrives, reply to it and we'll remove you by hand.",
  );
});
