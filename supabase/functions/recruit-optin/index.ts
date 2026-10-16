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
//     The recruit's click. READ-ONLY: it renders a page with one button.
//     Corporate link scanners (Safe Links, Proofpoint) follow every URL in a
//     delivered email, and when this GET recorded consent directly, 9 of the
//     first 10 invites "consented" — three of them between midnight and
//     4 a.m. from one employer's gateway — and none ever reached the
//     calculator. An unknown or lapsed token gets a friendly page pointing at
//     the public calculator — never "invalid token".
//
//   POST action=consent&t=<token>   (the button on that page; form-encoded)
//     Records consent (12 months, the owner's choice), mints a referral link
//     crediting the inviting LO (once per invite — stored on the row and
//     reused), counts it as a link use, tells the inviting LO, and
//     302-redirects to the calculator with the recruit's NMLS and current
//     comp prefilled: from there they email the recap to themselves, so its
//     footer's "you requested this" is literally true.
//
// Deployed verify_jwt=false: the GET and the form POST carry no session, and
// the invite POST verifies its own bearer the same way send-recap does.
import { normalizeEmail, suppressionVerdict } from "../send-recap/suppression.ts";
import { decideSourcingAction } from "../send-recap/sourcing.ts";
import { mintUnsubscribeToken } from "../unsubscribe/token.ts";
import { CONSENT_NOTICE_SUBJECT, INVITE_SUBJECT, renderConsentConfirmHtml, renderConsentNoticeHtml, renderExpiredHtml, renderInviteHtml } from "./copy.ts";
import { consentExpiry, consentRedirectUrl, decideInvite, parseBps, tokenState } from "./rules.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32}$/;

const APP_ORIGIN = () => Deno.env.get("APP_ORIGIN") || "https://htlrecruit.broker";
/** This function's public URL, for the consent form's action and the invite
 *  email's link. From SUPABASE_URL, never req.url: inside the edge runtime the
 *  request arrives rewritten (http scheme, `/functions/v1` stripped). */
const SELF_URL = () => `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/recruit-optin`;

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
  // The recruit's current comp, if the LO knows it. Optional: the invite is
  // still worth sending without it, but with it the comparison the recruit
  // lands on has a "today" column and a gain figure instead of "—".
  const bps = parseBps(body.bps);
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
  // Same decision function as send-recap's claim gate, not a second copy of it.
  const claim = await rest(`lo_sourcing?nmls=eq.${encodeURIComponent(nmls)}&select=nmls,sourced_by,expires_at`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  const c = Array.isArray(claim) && claim[0] ? claim[0] : null;
  const claimDecision = decideSourcingAction(c, senderId, Date.now(), { senderIsAdmin });
  if (claimDecision.kind === "blocked") {
    const holder = (await lookupUserEmail(claimDecision.claimedBy)) ?? claimDecision.claimedBy.slice(0, 8);
    return json(409, { error: "already_claimed", message: `This NMLS is already sourced by ${holder} until ${new Date(claimDecision.expiresAt).toLocaleDateString("en-US")}.` });
  }

  // One invite per mailbox per 30 days: a re-invite is a second unsolicited
  // email. Admins may re-invite (someone asked on a call to have it resent).
  const prior = await rest(`recruit_optins?recruit_email=eq.${encodeURIComponent(to)}&order=invited_at.desc&limit=1&select=invited_at,consented_at,consent_expires_at`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  const p = Array.isArray(prior) && prior[0] ? prior[0] : null;
  const decision = decideInvite(p, Date.now(), { senderIsAdmin });
  if (decision.kind === "already_consented") {
    return json(200, { ok: true, alreadyConsented: true, message: "This recruit already opted in — you can send the pro forma directly." });
  }
  if (decision.kind === "already_invited") {
    return json(409, { error: "already_invited", message: `An invite already went to this recruit on ${new Date(decision.invitedAt).toLocaleDateString("en-US")}. Re-invites inside 30 days need an admin.` });
  }

  const ins = await rest(`recruit_optins`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ nmls, recruit_email: to, invited_by: senderId, current_bps: bps }),
  });
  if (!ins.ok) return json(500, { error: "Couldn't record the invite." });
  const token = String((await ins.json())[0]?.token ?? "");
  if (!TOKEN_RE.test(token)) return json(500, { error: "Couldn't record the invite." });

  const base = Deno.env.get("SUPABASE_URL");
  const secret = Deno.env.get("UNSUBSCRIBE_SECRET");
  const unsubscribeUrl = secret && base
    ? `${base}/functions/v1/unsubscribe?t=${encodeURIComponent(await mintUnsubscribeToken(to, secret))}`
    : `mailto:marketing@hometownlend.com?subject=Unsubscribe`;

  try {
    await graphSend(to, senderEmail, INVITE_SUBJECT, renderInviteHtml({
      recruitName: name,
      loName: senderEmail?.split("@")[0] ?? "the recruiting team",
      loEmail: senderEmail ?? "aryanj@hometownlend.com",
      consentUrl: `${SELF_URL()}?t=${token}`,
      unsubscribeUrl,
    }));
  } catch (e) {
    // The row went in before the send so the token existed to put in the
    // email. If the email never left, the row must not stay: it would hold
    // the recruit behind the 30-day re-invite rule for an invite they never got.
    console.error("invite email failed — removing the invite row", e);
    await rest(`recruit_optins?token=eq.${token}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })
      .catch(err => console.error("invite row cleanup failed", err));
    return json(502, { error: "The invite email couldn't be sent, so nothing was recorded. Try again in a moment." });
  }
  console.log(`optin invite sent: nmls=${nmls} by ${senderEmail ?? senderId}`);
  return json(200, { ok: true, invited: to });
};

interface InviteRow {
  nmls: string; recruit_email: string; invited_by: string;
  consented_at: string | null; consent_expires_at: string | null;
  current_bps: number | null; referral_token: string | null;
}

const loadInvite = async (token: string): Promise<InviteRow | null> => {
  if (!TOKEN_RE.test(token)) return null;
  const rows = await rest(`recruit_optins?token=eq.${token}&select=nmls,recruit_email,invited_by,consented_at,consent_expires_at,current_bps,referral_token`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] as InviteRow : null;
};

const expiredPage = () => html(renderExpiredHtml(APP_ORIGIN()));

/** GET: the page behind the emailed link. Writes nothing — see the header. */
const consentPage = async (token: string): Promise<Response> => {
  const row = await loadInvite(token);
  const state = tokenState(row, Date.now());
  if (state === "unknown" || state === "lapsed") return expiredPage();
  return html(renderConsentConfirmHtml({ actionUrl: SELF_URL(), token, appOrigin: APP_ORIGIN() }));
};

/** Mint the referral link ONCE per invite and remember it on the row, so a
 *  second press of the button (or a second visit) reuses it. Returns the
 *  token, or null when minting failed (the redirect then proceeds unattributed). */
const referralTokenFor = async (token: string, row: InviteRow): Promise<string | null> => {
  if (row.referral_token) return row.referral_token;
  try {
    const link = await rest(`referral_links`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ created_by: row.invited_by, recruit_email: row.recruit_email }),
    });
    if (!link.ok) return null;
    const ref = String((await link.json())[0]?.token ?? "");
    if (!ref) return null;
    await rest(`recruit_optins?token=eq.${token}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ referral_token: ref }),
    }).catch(e => console.error("referral token not stored on the invite (non-fatal)", e));
    return ref;
  } catch (e) {
    console.error("referral link mint failed (redirect proceeds unattributed)", e);
    return null;
  }
};

/** A confirmed consent IS a use of the link: the recruit arrived through it.
 *  Until this, use_count only moved on an anonymous self-serve send, so every
 *  link on /links read 0 and weekly-review flagged them all stale. */
const bumpReferralUse = async (ref: string): Promise<void> => {
  try {
    const r = await rest(`referral_links?token=eq.${encodeURIComponent(ref)}&select=use_count`);
    const rows = r.ok ? await r.json() : null;
    const current = Array.isArray(rows) && rows[0] ? Number(rows[0].use_count) || 0 : 0;
    await rest(`referral_links?token=eq.${encodeURIComponent(ref)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ use_count: current + 1, last_used_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error("referral use bump failed (non-fatal)", e);
  }
};

/** Tell the inviting LO. Best-effort: a Graph hiccup must never cost the
 *  recruit their redirect. No figures in the notice — the LO has the app. */
const notifyInviter = async (row: InviteRow): Promise<void> => {
  try {
    const loEmail = await lookupUserEmail(row.invited_by);
    if (!loEmail) return;
    await graphSend(loEmail, null, CONSENT_NOTICE_SUBJECT, renderConsentNoticeHtml({
      recruitEmail: row.recruit_email, nmls: row.nmls, linksUrl: `${APP_ORIGIN()}/links`,
    }));
  } catch (e) {
    console.error("consent notice to the inviting LO failed (non-fatal)", e);
  }
};

/** POST action=consent: the only path that records anything. */
const consentFlow = async (token: string): Promise<Response> => {
  const row = await loadInvite(token);
  const state = tokenState(row, Date.now());
  if (!row || state === "unknown" || state === "lapsed") return expiredPage();

  if (state === "fresh") {
    const now = Date.now();
    const patch = await rest(`recruit_optins?token=eq.${token}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ consented_at: new Date(now).toISOString(), consent_expires_at: consentExpiry(now), consented_via: "confirm_post" }),
    });
    if (!patch.ok) {
      console.error("consent PATCH failed", patch.status, await patch.text().catch(() => ""));
      return html(renderExpiredHtml(APP_ORIGIN()), 503);
    }
    console.log(`optin consent recorded: nmls=${row.nmls} email=${row.recruit_email}`);
    await notifyInviter(row);
  }

  // Attribution rides the existing referral machinery: the redirect carries a
  // referral token created for the INVITING LO, so the recap the recruit sends
  // themselves credits whoever did the outreach — same as a shared PURL.
  const ref = await referralTokenFor(token, row);
  if (ref && state === "fresh") await bumpReferralUse(ref);

  const dest = consentRedirectUrl(APP_ORIGIN(), String(row.nmls), ref, row.current_bps);
  return new Response(null, { status: 302, headers: { ...CORS, Location: dest } });
};

/** The consent button posts a form; the app posts JSON. Both become one map. */
const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const out: Record<string, unknown> = {};
      form.forEach((v, k) => { out[k] = typeof v === "string" ? v : String(v); });
      return out;
    }
    return await req.json();
  } catch {
    return null;
  }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") {
      return await consentPage(new URL(req.url).searchParams.get("t") ?? "");
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body) return json(400, { error: "Invalid request body." });
      if (body.action === "invite") return await inviteFlow(req, body);
      if (body.action === "consent") return await consentFlow(String(body.t ?? ""));
      return json(400, { error: "Unknown action." });
    }
    return json(405, { error: "Method not allowed" });
  } catch (e) {
    console.error("recruit-optin error", e);
    return json(500, { error: "Something went wrong." });
  }
});
