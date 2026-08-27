// Recruit opt-in: the invite an LO sends INSTEAD of a cold pro forma, and the
// consent click that unlocks the real one.
//
//   POST { action: "invite", nmls, email, name? }
//     Signed-in team member only (verified against /auth/v1/user, same rule as
//     HTL5 attribution). Mints a consent token, records the invite, and emails
//     the recruit the figure-free invitation. Refuses when the recipient has
//     unsubscribed, when another LO holds a live claim on the NMLS, or when a
//     pending invite is under 30 days old (a re-invite is a second unsolicited
//     email; admins may re-invite).
//
//   GET ?t=<token>
//     The recruit's click. No auth — the token is the authorization, like the
//     unsubscribe link. Records consent (12 months, the owner's choice), mints
//     a referral link crediting the inviting LO, and 302-redirects to the
//     calculator with the recruit's NMLS prefilled: from there they email the
//     recap to themselves, so its footer's "you requested this" is literally
//     true. An unknown or lapsed token gets a friendly page pointing at the
//     public calculator — never "invalid token".
//
// Deployed verify_jwt=false: the GET carries no session, and the POST verifies
// its own bearer the same way send-recap does.
import { normalizeEmail, suppressionVerdict } from "../send-recap/suppression.ts";
import { mintUnsubscribeToken } from "../unsubscribe/token.ts";
import { INVITE_SUBJECT, renderExpiredHtml, renderInviteHtml } from "./copy.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32}$/;

const APP_ORIGIN = () => Deno.env.get("APP_ORIGIN") || "https://htlrecruit.broker";

// ---- Graph (same client-credentials flow as weekly-review, module-cached) ----
let graphToken: { token: string; expiresAt: number } | null = null;
const graphSend = async (to: string, replyTo: string | null, subject: string, html: string): Promise<void> => {
  const tenantId = Deno.env.get("GRAPH_TENANT_ID"), clientId = Deno.env.get("GRAPH_CLIENT_ID"),
    clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET"), sender = Deno.env.get("RECAP_SENDER");
  if (!tenantId || !clientId || !clientSecret || !sender) throw new Error("Graph email is not configured.");
  if (!graphToken || graphToken.expiresAt <= Date.now()) {
    const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`Graph token ${resp.status}`);
    const data = await resp.json();
    graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  }
  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    // Replies reach the inviting LO directly — the invite is signed by them.
    ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
  };
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${graphToken.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status !== 202) throw new Error(`Graph send ${resp.status}: ${await resp.text().catch(() => "")}`);
};

// ---- service-role REST helpers ----
const rest = async (path: string, init?: RequestInit): Promise<Response> => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("storage not configured");
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
};

/** Verified caller id — never the JWT payload (same rule as send-recap). */
const verifiedSenderId = async (req: Request): Promise<string | null> => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || !url || !key) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data?.id === "string" && UUID_RE.test(data.id) ? data.id : null;
  } catch { return null; }
};

const lookupUserEmail = async (userId: string): Promise<string | null> => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d?.email === "string" ? d.email : null;
  } catch { return null; }
};

const isAdminEmail = async (email: string): Promise<boolean> => {
  try {
    const r = await rest(`app_admins?email=eq.${encodeURIComponent(email.toLowerCase())}&select=email`);
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; } // fail closed — an override is the permissive path
};

const inviteFlow = async (req: Request, body: Record<string, unknown>): Promise<Response> => {
  const senderId = await verifiedSenderId(req);
  if (!senderId) return json(401, { error: "Sign in to send invites." });
  const nmls = String(body.nmls ?? "").replace(/\D/g, "");
  const to = normalizeEmail(String(body.email ?? ""));
  const name = typeof body.name === "string" ? body.name.slice(0, 120) : null;
  if (!nmls) return json(400, { error: "A recruit NMLS number is required." });
  if (!EMAIL_RE.test(to)) return json(400, { error: "That doesn't look like a valid email address." });

  // Unsubscribed means unsubscribed — an invite is still marketing email.
  // Same quiet contract as send-recap: a suppressed recipient returns ok with a
  // marker, so the UI can say "on the do-not-email list" without an error path.
  const verdict = suppressionVerdict(
    await rest(`email_suppressions?select=email&email=eq.${encodeURIComponent(to)}`)
      .then(async r => ({ ok: r.ok, rows: r.ok ? await r.json() : null }))
      .catch(() => null),
  );
  if (verdict === "suppressed") return json(200, { ok: true, suppressed: true });
  if (verdict === "unavailable") return json(503, { error: "Couldn't check the do-not-email list — try again in a moment." });

  const senderEmail = await lookupUserEmail(senderId);
  const senderIsAdmin = senderEmail ? await isAdminEmail(senderEmail) : false;

  // Another LO's live claim covers invites too — first sender wins the recruit.
  const claim = await rest(`lo_sourcing?nmls=eq.${encodeURIComponent(nmls)}&select=sourced_by,expires_at`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  const c = Array.isArray(claim) ? claim[0] : null;
  if (c && c.sourced_by !== senderId && new Date(String(c.expires_at)).getTime() > Date.now() && !senderIsAdmin) {
    const holder = (await lookupUserEmail(String(c.sourced_by))) ?? String(c.sourced_by).slice(0, 8);
    return json(409, { error: "already_claimed", message: `This NMLS is already sourced by ${holder} until ${new Date(String(c.expires_at)).toLocaleDateString("en-US")}.` });
  }

  // One invite per mailbox per 30 days: a re-invite is a second unsolicited
  // email. Admins may re-invite (someone asked on a call to have it resent).
  const prior = await rest(`recruit_optins?recruit_email=eq.${encodeURIComponent(to)}&order=invited_at.desc&limit=1&select=invited_at,consented_at,consent_expires_at`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  const p = Array.isArray(prior) ? prior[0] : null;
  if (p?.consented_at && new Date(String(p.consent_expires_at)).getTime() > Date.now()) {
    return json(200, { ok: true, alreadyConsented: true, message: "This recruit already opted in — you can send the pro forma directly." });
  }
  if (p && !senderIsAdmin && Date.now() - new Date(String(p.invited_at)).getTime() < 30 * 86_400_000) {
    return json(409, { error: "already_invited", message: `An invite already went to this recruit on ${new Date(String(p.invited_at)).toLocaleDateString("en-US")}. Re-invites inside 30 days need an admin.` });
  }

  const ins = await rest(`recruit_optins`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ nmls, recruit_email: to, invited_by: senderId }),
  });
  if (!ins.ok) return json(500, { error: "Couldn't record the invite." });
  const token = String((await ins.json())[0]?.token ?? "");
  if (!TOKEN_RE.test(token)) return json(500, { error: "Couldn't record the invite." });

  const base = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  const unsubscribeUrl = secret && base
    ? `${base}/functions/v1/unsubscribe?t=${encodeURIComponent(await mintUnsubscribeToken(to, secret))}`
    : `mailto:marketing@hometownlend.com?subject=Unsubscribe`;

  await graphSend(to, senderEmail, INVITE_SUBJECT, renderInviteHtml({
    recruitName: name,
    loName: senderEmail?.split("@")[0] ?? "the recruiting team",
    loEmail: senderEmail ?? "aryanj@hometownlend.com",
    consentUrl: `${base}/functions/v1/recruit-optin?t=${token}`,
    unsubscribeUrl,
  }));
  console.log(`optin invite sent: nmls=${nmls} by ${senderEmail ?? senderId}`);
  return json(200, { ok: true, invited: to });
};

const consentFlow = async (token: string): Promise<Response> => {
  const expired = () => new Response(renderExpiredHtml(APP_ORIGIN()), { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
  if (!TOKEN_RE.test(token)) return expired();
  const rows = await rest(`recruit_optins?token=eq.${token}&select=nmls,recruit_email,invited_by,consented_at,consent_expires_at`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return expired();
  // Consented long ago and lapsed → the link no longer proves fresh consent.
  if (row.consented_at && new Date(String(row.consent_expires_at)).getTime() <= Date.now()) return expired();

  if (!row.consented_at) {
    const now = new Date();
    const expiresAt = new Date(now.getTime()); expiresAt.setMonth(expiresAt.getMonth() + 12);
    await rest(`recruit_optins?token=eq.${token}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ consented_at: now.toISOString(), consent_expires_at: expiresAt.toISOString(), consented_via: "link_click" }),
    });
    console.log(`optin consent recorded: nmls=${row.nmls} email=${row.recruit_email}`);
  }

  // Attribution rides the existing referral machinery: the redirect carries a
  // referral token created for the INVITING LO, so the recap the recruit sends
  // themselves credits whoever did the outreach — same as a shared PURL.
  let ref = "";
  try {
    const link = await rest(`referral_links`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ created_by: row.invited_by, recruit_email: row.recruit_email }),
    });
    if (link.ok) ref = String((await link.json())[0]?.token ?? "");
  } catch (e) {
    console.error("referral link mint failed (redirect proceeds unattributed)", e);
  }

  const dest = `${APP_ORIGIN()}/?${ref ? `ref=${ref}&` : ""}nmls=${encodeURIComponent(String(row.nmls))}`;
  return new Response(null, { status: 302, headers: { ...CORS, Location: dest } });
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") {
      return await consentFlow(new URL(req.url).searchParams.get("t") ?? "");
    }
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON." }); }
      if (body.action === "invite") return await inviteFlow(req, body);
      return json(400, { error: "Unknown action." });
    }
    return json(405, { error: "Method not allowed" });
  } catch (e) {
    console.error("recruit-optin error", e);
    return json(500, { error: "Something went wrong." });
  }
});
