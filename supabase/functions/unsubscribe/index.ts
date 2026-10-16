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
import { renderUnsubscribeConfirmHtml, renderUnsubscribeErrorHtml, renderUnsubscribedHtml } from "./page.ts";

// Same local declaration the other functions use — the Deno types aren't
// available to the repo's tsc invocation, only to the deploy runtime.
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });

/** This function's public URL, for the confirmation form's action. Built from
 *  SUPABASE_URL, not from req.url: inside the edge runtime the request arrives
 *  rewritten (http scheme, `/functions/v1` stripped), so a form built from
 *  req.url posted to a URL that does not exist from the outside. */
const selfUrl = (req: Request): string => {
  const base = Deno.env.get("SUPABASE_URL");
  if (base) return `${base.replace(/\/$/, "")}/functions/v1/unsubscribe`;
  const u = new URL(req.url);
  return `${u.origin}${u.pathname}`;
};

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
      // Idempotent: a provider may POST once and the human press the button
      // too. A repeat opt-out is a success, not a duplicate-key error — and
      // ignore-duplicates (not merge) keeps the FIRST row, so the record of
      // HOW someone opted out survives a later click.
      Prefer: "resolution=ignore-duplicates,return=minimal",
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
    return html(renderUnsubscribeErrorHtml(), 503);
  }

  const url = new URL(req.url);
  const queryToken = url.searchParams.get("t") ?? "";

  // GET = the footer link = whatever a link scanner fetches. It renders the
  // confirmation page and writes NOTHING. The page is identical for a valid
  // and an invalid token, so a GET never reveals whether an address is on file.
  if (req.method === "GET") {
    return html(renderUnsubscribeConfirmHtml(selfUrl(req), queryToken));
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  // POST = the confirmation button (form-encoded t=) or an RFC 8058 one-click
  // client (body "List-Unsubscribe=One-Click", token in the URL).
  let bodyText = "";
  try { bodyText = await req.text(); } catch { /* fall through with an empty body */ }
  const params = new URLSearchParams(bodyText);
  const token = queryToken || params.get("t") || bodyText.trim();
  const oneClick = params.get("List-Unsubscribe") === "One-Click";

  const email = await verifyUnsubscribeToken(token, secret);
  if (!email) {
    // Deliberately indistinguishable from success to the person reading it.
    console.warn("unsubscribe: invalid or missing token");
    return html(renderUnsubscribedHtml(null));
  }

  const ok = await suppress(email, oneClick ? "one-click-post" : "confirm-page");
  console.log(`unsubscribe: ${ok ? "suppressed" : "FAILED"} ${email} via ${oneClick ? "one-click" : "confirm page"}`);
  return html(renderUnsubscribedHtml(ok ? email : null));
});
