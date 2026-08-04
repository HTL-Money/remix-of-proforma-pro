// Supabase Edge Function: the Monday weekly review.
//
// Two-phase design so an AI session can write the narrative between phases:
//   { action: "collect", key? }                    → computed metrics JSON;
//     without the key, recruit emails and NMLS numbers are redacted out
//   { action: "send", narrative?, actionsTaken?, cadence? }  → emails the
//     report to the admin; cadence "daily" (the 21-day launch monitoring
//     window) skips the snapshot write so trend rows stay Monday-only
//   { action: "signinReport", key }                → adoption report: who in
//     the rollout cohort has signed in, and who never has
//   { action: "announce", key }                    → the LO rollout email
//     (sign-in details + shared temp password) to every cohort member
//   { action: "notify", key, subject, html }       → one-off admin notice
//
// `verify_jwt` is on, but the anon key it accepts ships in the browser bundle,
// so it is NOT an authorization signal: every action that sends mail with
// caller-supplied content, or to anyone other than the admin, additionally
// requires ADMIN_TASK_KEY (see adminKeyOk). Admin recipient: WEEKLY_REVIEW_TO
// secret, default jamesm@hometownlend.com. Email health numbers make the
// weekly report admin-only by audience; if distribution ever widens, that
// section must be split out.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const REVIEW_TO = Deno.env.get("WEEKLY_REVIEW_TO") || "jamesm@hometownlend.com";

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- Graph send (ported from send-recap; text-only, no attachments) --------

interface GraphConfig { tenantId: string; clientId: string; clientSecret: string; sender: string }

const graphConfig = (): GraphConfig | null => {
  const tenantId = Deno.env.get("GRAPH_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET");
  const sender = Deno.env.get("RECAP_SENDER");
  return tenantId && clientId && clientSecret && sender ? { tenantId, clientId, clientSecret, sender } : null;
};

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
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Graph token ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json();
  graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return graphToken.token;
};

const sendAdminEmail = (subject: string, html: string): Promise<void> =>
  sendEmailTo(REVIEW_TO, subject, html);

const sendEmailTo = async (to: string, subject: string, html: string): Promise<void> => {
  const cfg = graphConfig();
  if (!cfg) throw new Error("Graph email is not configured.");
  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  const post = async (token: string) =>
    fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
      signal: AbortSignal.timeout(30_000),
    });
  let resp = await post(await getGraphToken(cfg));
  if (resp.status === 401) {
    graphToken = null;
    resp = await post(await getGraphToken(cfg));
  }
  if (resp.status !== 202) throw new Error(`Graph send ${resp.status}: ${await resp.text().catch(() => "")}`);
};

// ---- Data access (service role) --------------------------------------------

const rest = async (path: string): Promise<unknown[]> => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      console.error("rest read failed", path, r.status);
      return [];
    }
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error("rest read threw", path, e);
    return [];
  }
};

const upsertSnapshot = async (weekStart: string, metrics: unknown): Promise<void> => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/metrics_snapshots?on_conflict=week_start`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ week_start: weekStart, metrics }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error("snapshot write failed (non-fatal)", e);
  }
};

// ---- Team accounts (auth admin API) -----------------------------------------

// The 42 LO accounts were provisioned 2026-08-04; sign-in tracking measures
// adoption from that date. These service/legacy accounts are not part of it.
const SIGNIN_LAUNCH = "2026-08-04";
// The rollout cohort is defined once: accounts created on launch day, minus
// these. Adoption is measured against exactly the people who got the
// announcement, so "12 of 41 have signed in" always means the same 41 — no
// service accounts, no admins who never needed the email, and nobody sitting
// in the never-visited column who was never invited.
//   admin@ / fey@              — legacy service logins
//   accounting@               — admin-only account, deliberately not announced
//   mikeh@ / adrianag@ /
//   valeriab@                 — pulled from the rollout by the owner. Their
//                               accounts still exist; they are simply not
//                               announced to and not counted in adoption.
//   jamesm@ / aryanj@         — predate launch day (excluded by date anyway)
const COHORT_EXCLUDE = new Set([
  "admin@hometownlend.com",
  "fey@hometownlend.com",
  "accounting@hometownlend.com",
  "mikeh@hometownlend.com",
  "adrianag@hometownlend.com",
  "valeriab@hometownlend.com",
  "jamesm@hometownlend.com",
  "aryanj@hometownlend.com",
]);

interface TeamAccount { email: string; name: string; createdAt: string; lastSignInAt: string | null }

const listTeamAccounts = async (): Promise<TeamAccount[]> => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  const out: TeamAccount[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`admin users list ${r.status}`);
    const data = await r.json() as { users?: { email?: string; created_at?: string; last_sign_in_at?: string | null; user_metadata?: { full_name?: string } }[] };
    const users = data.users ?? [];
    for (const u of users) {
      if (!u.email) continue;
      out.push({
        email: u.email.toLowerCase(),
        name: u.user_metadata?.full_name ?? u.email.split("@")[0],
        createdAt: u.created_at ?? "",
        lastSignInAt: u.last_sign_in_at ?? null,
      });
    }
    if (users.length < 100) break;
  }
  return out;
};

// Launch day only — a closed window, not an open-ended "since". Without the
// upper bound every account created later joined the cohort silently: it would
// inflate the "X of 41" denominator, and a re-run of `announce` would mail the
// shared temporary password to someone who was never part of the rollout.
const SIGNIN_LAUNCH_END = "2026-08-05";

/** The rollout cohort: accounts provisioned on launch day, minus the
 *  exclusions. Both the announcement and the adoption report use this. */
const cohort = async (): Promise<TeamAccount[]> =>
  (await listTeamAccounts()).filter(a =>
    !COHORT_EXCLUDE.has(a.email) &&
    a.createdAt >= SIGNIN_LAUNCH &&
    a.createdAt < SIGNIN_LAUNCH_END);

/** Adoption split across the cohort. */
const signInStatus = async () => {
  const accounts = await cohort();
  const signedIn = accounts
    .filter(a => a.lastSignInAt && a.lastSignInAt >= SIGNIN_LAUNCH)
    .sort((a, b) => (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""));
  const missing = accounts
    .filter(a => !a.lastSignInAt || a.lastSignInAt < SIGNIN_LAUNCH)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { total: accounts.length, signedIn, missing };
};

// ---- Metrics ----------------------------------------------------------------

interface WeekWindow { since: string; prior: string }

const windows = (): WeekWindow => {
  const now = Date.now();
  return {
    since: new Date(now - 7 * 86_400_000).toISOString(),
    prior: new Date(now - 14 * 86_400_000).toISOString(),
  };
};

/** ISO Monday of the current week, as YYYY-MM-DD (snapshot key). */
const isoWeekStart = (): string => {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

const tierOf = (volume: number): string => {
  if (volume >= 48_000_000) return "$48M+";
  if (volume >= 24_000_000) return "$24–48M";
  if (volume >= 10_000_000) return "$10–24M";
  return "<$10M";
};

const collectMetrics = async () => {
  const { since, prior } = windows();
  const [links, proformas, emails, claims, directory, snapshots] = await Promise.all([
    rest(`referral_links?select=token,created_by,created_at,use_count,last_used_at,recruit_email`),
    rest(`proformas?select=source,annual_volume,created_at&created_at=gte.${encodeURIComponent(prior)}`),
    rest(`recap_emails?select=status,sent_by,created_at&created_at=gte.${encodeURIComponent(prior)}`),
    rest(`lo_sourcing?select=nmls,sourced_by,sourced_at,expires_at`),
    rest(`team_directory?select=id,email`),
    rest(`metrics_snapshots?select=week_start,metrics&order=week_start.desc&limit=4`),
  ]);

  const emailOf = new Map((directory as { id: string; email: string }[]).map(d => [d.id, d.email]));
  const inWeek = (ts: unknown) => typeof ts === "string" && ts >= since;
  const inPrior = (ts: unknown) => typeof ts === "string" && ts >= prior && ts < since;

  type L = { token: string; created_by: string; created_at: string; use_count: number; last_used_at: string | null };
  type P = { source: string | null; annual_volume: number | null; created_at: string };
  type E = { status: string | null; sent_by: string | null; created_at: string };
  type C = { nmls: string; sourced_by: string; sourced_at: string; expires_at: string };

  const l = links as L[], p = proformas as P[], e = emails as E[], c = claims as C[];

  const countBy = <T,>(rows: T[], f: (r: T) => boolean) => rows.filter(f).length;
  const emailStatus = (rows: E[], status: string, f: (r: E) => boolean) =>
    rows.filter(r => (r.status ?? "sent") === status && f(r)).length;

  // Leaderboard: per team member, this week's links created / links used /
  // sends / claims.
  const board: Record<string, { linksCreated: number; linkUses: number; sends: number; claims: number }> = {};
  const rowFor = (id: string) => (board[id] ??= { linksCreated: 0, linkUses: 0, sends: 0, claims: 0 });
  for (const r of l) {
    if (inWeek(r.created_at)) rowFor(r.created_by).linksCreated++;
    if (inWeek(r.last_used_at)) rowFor(r.created_by).linkUses++;
  }
  for (const r of e) if (r.sent_by && inWeek(r.created_at)) rowFor(r.sent_by).sends++;
  for (const r of c) if (inWeek(r.sourced_at)) rowFor(r.sourced_by).claims++;

  const now = Date.now();
  const in14d = new Date(now + 14 * 86_400_000).toISOString();

  return {
    generatedAt: new Date().toISOString(),
    weekStart: isoWeekStart(),
    funnel: {
      linksCreated: { week: countBy(l, r => inWeek(r.created_at)), prior: countBy(l, r => inPrior(r.created_at)) },
      linksUsed: { week: countBy(l, r => inWeek(r.last_used_at)), prior: countBy(l, r => inPrior(r.last_used_at)) },
      submissions: {
        week: countBy(p, r => inWeek(r.created_at)),
        prior: countBy(p, r => inPrior(r.created_at)),
        bySource: {
          public: countBy(p, r => inWeek(r.created_at) && r.source === "public"),
          direct: countBy(p, r => inWeek(r.created_at) && r.source === "lo_direct_send"),
          team: countBy(p, r => inWeek(r.created_at) && r.source !== "public" && r.source !== "lo_direct_send"),
        },
      },
      claims: { week: countBy(c, r => inWeek(r.sourced_at)), prior: countBy(c, r => inPrior(r.sourced_at)) },
      claimsExpiringSoon: c
        .filter(r => r.expires_at > new Date(now).toISOString() && r.expires_at <= in14d)
        .map(r => ({ nmls: r.nmls, holder: emailOf.get(r.sourced_by) ?? r.sourced_by.slice(0, 8), expires: r.expires_at.slice(0, 10) })),
    },
    leaderboard: Object.entries(board)
      .map(([id, v]) => ({ who: emailOf.get(id) ?? id.slice(0, 8), ...v }))
      .sort((a, b) => (b.claims - a.claims) || (b.sends - a.sends) || (b.linksCreated - a.linksCreated)),
    quality: {
      weekTiers: p.filter(r => inWeek(r.created_at) && r.annual_volume != null)
        .reduce<Record<string, number>>((acc, r) => {
          const t = tierOf(Number(r.annual_volume));
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {}),
    },
    emailHealth: {
      sent: emailStatus(e, "sent", r => inWeek(r.created_at)),
      suppressed: emailStatus(e, "suppressed", r => inWeek(r.created_at)),
      negativeGain: emailStatus(e, "negative_gain", r => inWeek(r.created_at)),
      priorSent: emailStatus(e, "sent", r => inPrior(r.created_at)),
    },
    usageFlags: {
      staleLinks: l
        .filter(r => r.use_count === 0 && r.created_at < new Date(now - 21 * 86_400_000).toISOString())
        .map(r => ({ recruit: r.recruit_email, owner: emailOf.get(r.created_by) ?? r.created_by.slice(0, 8), created: r.created_at.slice(0, 10) })),
      decksGeneratedThisWeek: (await rest(`recap_presentations?select=recap_hash&created_at=gte.${encodeURIComponent(since)}`)).length,
    },
    history: (snapshots as { week_start: string; metrics: unknown }[]).map(s => ({ week: s.week_start })),
    // Adoption tracking (21-day launch window and beyond). Best-effort: an
    // auth-API hiccup must never sink the rest of the report.
    signIns: await signInStatus()
      .then(s => ({ signedIn: s.signedIn.length, total: s.total, missing: s.missing.map(a => a.name) }))
      .catch(e => { console.error("signIns unavailable", e); return null; }),
  };
};

// ---- Report rendering --------------------------------------------------------

const NAVY = "#13294B";

const kpiRow = (label: string, week: number, prior: number): string => {
  const delta = prior === 0 ? (week > 0 ? "new" : "—") : `${week >= prior ? "+" : ""}${(((week - prior) / prior) * 100).toFixed(0)}%`;
  return `<tr><td style="padding:6px 12px 6px 0;color:#4a4a4a">${escHtml(label)}</td><td style="padding:6px 12px;font-weight:600">${week}</td><td style="padding:6px 12px;color:#7a7a7a">prev ${prior}</td><td style="padding:6px 0;color:${week >= prior ? "#2f7d5d" : "#a33"}">${delta}</td></tr>`;
};

// deno-lint-ignore no-explicit-any
const renderReport = (m: any, narrative: string, actionsTaken: string[]): string => {
  const lb = (m.leaderboard as { who: string; linksCreated: number; linkUses: number; sends: number; claims: number }[])
    .map(r => `<tr><td style="padding:4px 12px 4px 0">${escHtml(r.who)}</td><td style="padding:4px 12px;text-align:center">${r.linksCreated}</td><td style="padding:4px 12px;text-align:center">${r.linkUses}</td><td style="padding:4px 12px;text-align:center">${r.sends}</td><td style="padding:4px 0;text-align:center;font-weight:600">${r.claims}</td></tr>`)
    .join("") || `<tr><td colspan="5" style="padding:8px 0;color:#7a7a7a">No team activity this week.</td></tr>`;
  const tiers = Object.entries(m.quality.weekTiers as Record<string, number>)
    .map(([t, n]) => `<span style="display:inline-block;margin-right:14px"><b>${escHtml(t)}</b>: ${n}</span>`)
    .join("") || `<span style="color:#7a7a7a">No new recruits touched this week.</span>`;
  const expiring = (m.funnel.claimsExpiringSoon as { nmls: string; holder: string; expires: string }[])
    .map(r => `<li>NMLS ${escHtml(r.nmls)} — ${escHtml(r.holder)}, expires ${escHtml(r.expires)}</li>`)
    .join("");
  const stale = (m.usageFlags.staleLinks as { recruit: string; owner: string; created: string }[])
    .map(r => `<li>${escHtml(r.recruit)} (link by ${escHtml(r.owner)}, created ${escHtml(r.created)}) — never opened</li>`)
    .join("");
  const acts = actionsTaken.map(a => `<li>${escHtml(a)}</li>`).join("");

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
    <div style="background:${NAVY};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
      <div style="font-size:18px;font-weight:700">ProFarmA Weekly Review</div>
      <div style="font-size:12px;color:#BEBFC3">Week of ${escHtml(String(m.weekStart))} · admin-only report</div>
    </div>
    <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:20px">
      ${narrative ? `<div style="background:#f6f8fa;border-left:3px solid ${NAVY};padding:12px 14px;margin-bottom:18px;white-space:pre-wrap">${escHtml(narrative)}</div>` : ""}
      <h3 style="color:${NAVY};margin:0 0 6px">Recruiting funnel</h3>
      <table style="border-collapse:collapse;font-size:14px">
        ${kpiRow("PURLs created", m.funnel.linksCreated.week, m.funnel.linksCreated.prior)}
        ${kpiRow("PURLs used", m.funnel.linksUsed.week, m.funnel.linksUsed.prior)}
        ${kpiRow("Submissions", m.funnel.submissions.week, m.funnel.submissions.prior)}
        ${kpiRow("90-day claims", m.funnel.claims.week, m.funnel.claims.prior)}
      </table>
      <div style="font-size:13px;color:#4a4a4a;margin:6px 0 16px">
        This week's submissions: ${m.funnel.submissions.bySource.public} self-serve · ${m.funnel.submissions.bySource.direct} direct send · ${m.funnel.submissions.bySource.team} team-entered
      </div>
      <h3 style="color:${NAVY};margin:16px 0 6px">LO leaderboard (this week)</h3>
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        <tr style="color:#7a7a7a;text-align:center"><td style="text-align:left">Team member</td><td>Links</td><td>Uses</td><td>Sends</td><td>Claims</td></tr>
        ${lb}
      </table>
      <h3 style="color:${NAVY};margin:16px 0 6px">Recruit quality (annual volume)</h3>
      <div style="font-size:14px">${tiers}</div>
      <h3 style="color:${NAVY};margin:16px 0 6px">Email health</h3>
      <div style="font-size:14px">
        Sent: <b>${m.emailHealth.sent}</b> (prev ${m.emailHealth.priorSent}) ·
        Suppressed: <b>${m.emailHealth.suppressed}</b> ·
        Withheld (no gain): <b>${m.emailHealth.negativeGain}</b>
      </div>
      ${m.signIns ? `<h3 style="color:${NAVY};margin:16px 0 6px">Team sign-ins</h3>
      <div style="font-size:14px"><b>${m.signIns.signedIn} of ${m.signIns.total}</b> team members have signed in since launch.</div>
      ${m.signIns.missing.length ? `<div style="font-size:13px;color:#4a4a4a;margin-top:4px">Not yet: ${(m.signIns.missing as string[]).map(escHtml).join(", ")}</div>` : ""}` : ""}
      ${expiring ? `<h3 style="color:${NAVY};margin:16px 0 6px">Claims expiring within 14 days</h3><ul style="font-size:13px;margin:4px 0">${expiring}</ul>` : ""}
      ${stale ? `<h3 style="color:${NAVY};margin:16px 0 6px">Never-used links (21+ days)</h3><ul style="font-size:13px;margin:4px 0">${stale}</ul>` : ""}
      <div style="font-size:13px;color:#4a4a4a;margin-top:8px">Gamma decks generated this week: ${m.usageFlags.decksGeneratedThisWeek}</div>
      ${acts ? `<h3 style="color:${NAVY};margin:16px 0 6px">Actions taken automatically</h3><ul style="font-size:13px;margin:4px 0">${acts}</ul>` : ""}
      <div style="font-size:11px;color:#9a9a9a;margin-top:20px;border-top:1px solid #eee;padding-top:10px">
        Generated ${escHtml(String(m.generatedAt))} · metrics snapshot stored for trend history · email health is admin-only content
      </div>
    </div>
  </div>`;
};

// ---- LO announcement ---------------------------------------------------------

const announceHtml = (firstName: string, email: string, password: string): string => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:${NAVY};color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">
    <div style="font-size:19px;font-weight:700">Hometown Lending — Recruiting Tool</div>
  </div>
  <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:22px">
    <p style="margin:0 0 12px">Hi ${escHtml(firstName)},</p>
    <p style="margin:0 0 12px">
      Your sign-in for HTL's new recruiting tool is ready. It builds a personalized
      pro forma for any loan officer you're talking to — showing them exactly what
      their numbers look like here — and emails it to them as a polished report
      with your name attached.
    </p>
    <p style="margin:0 0 12px">
      <b>Why it's worth your time:</b> any recruit you bring through your link is
      attached to you for HTL5 rev share — first sender wins the 90-day claim.
    </p>
    <table style="border-collapse:collapse;font-size:14px;background:#f6f8fa;border-left:3px solid ${NAVY};margin:16px 0;width:100%">
      <!-- /links, not the bare domain: signed out, "/" is the recruit-facing
           calculator with no sign-in affordance on it by design, so the bare
           domain would land 41 people on a page with no way in. /links shows
           the login gate, and is where they end up after signing in anyway. -->
      <tr><td style="padding:10px 14px 2px;color:#4a4a4a">Sign in</td><td style="padding:10px 14px 2px"><a href="https://htlrecruit.broker/links" style="color:${NAVY};font-weight:600">htlrecruit.broker/links</a></td></tr>
      <tr><td style="padding:2px 14px;color:#4a4a4a">Email</td><td style="padding:2px 14px;font-weight:600">${escHtml(email)}</td></tr>
      <tr><td style="padding:2px 14px 10px;color:#4a4a4a">Temporary password</td><td style="padding:2px 14px 10px;font-weight:600">${escHtml(password)}</td></tr>
    </table>
    <p style="margin:0 0 12px">
      <b>First thing after you sign in:</b> use <i>Change password</i> in the
      sidebar to set your own — this temporary one is shared across the team and
      will be retired soon.
    </p>
    <p style="margin:0 0 12px">
      Then open <b>Recruit Links</b> to grab your personal link or send a pro
      forma directly. Questions — reply to this email or grab James.
    </p>
    <p style="margin:16px 0 0;color:#4a4a4a">— James Mowery, Director of Sales</p>
  </div>
</div>`;

// ---- Handler -----------------------------------------------------------------

/** Strips recruit-identifying fields from a metrics bundle, leaving the counts
 *  and the team-side names a narrative needs. Used for unkeyed `collect`. */
// deno-lint-ignore no-explicit-any
const redactPeople = (m: any) => ({
  ...m,
  funnel: {
    ...m.funnel,
    claimsExpiringSoon: (m.funnel.claimsExpiringSoon as unknown[]).length,
  },
  // Teammate identities are as much PII as recruit ones: drop the leaderboard's
  // emails and the stale-link owners, keep the shape and the counts.
  leaderboard: (m.leaderboard as unknown[]).length,
  usageFlags: {
    ...m.usageFlags,
    staleLinks: (m.usageFlags.staleLinks as unknown[]).length,
  },
  // Who has not signed in yet is a roster of names; the counts are harmless.
  signIns: m.signIns ? { signedIn: m.signIns.signedIn, total: m.signIns.total } : null,
  // Deliverability and suppression counts are admin-only by audience.
  emailHealth: undefined,
});

/** Gate for the actions that send mail with caller-influenced content or to
 *  anyone other than the admin. `verify_jwt` only proves the caller has the
 *  public anon key, which ships in the browser bundle — so it is not an
 *  authorization signal. Length-then-constant-time compare. */
const adminKeyOk = (given: unknown): boolean => {
  const want = Deno.env.get("ADMIN_TASK_KEY");
  if (!want || typeof given !== "string" || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body: { action?: unknown; narrative?: unknown; actionsTaken?: unknown; subject?: unknown; html?: unknown; cadence?: unknown; key?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  if (body.action === "collect") {
    // Unkeyed callers get the numbers but not the people. `verify_jwt` only
    // proves possession of the public anon key (it ships in the browser
    // bundle), so an unkeyed response must not carry recruit emails or NMLS
    // numbers. The Monday/daily routines write their narrative from counts and
    // team names, and `send` recomputes metrics server-side — so the emailed
    // report still contains the full detail either way.
    const metrics = await collectMetrics();
    return json(200, { ok: true, metrics: adminKeyOk(body.key) ? metrics : redactPeople(metrics) });
  }

  if (body.action === "send") {
    const narrative = typeof body.narrative === "string" ? body.narrative.slice(0, 8_000) : "";
    const actionsTaken = Array.isArray(body.actionsTaken)
      ? body.actionsTaken.filter((a): a is string => typeof a === "string").slice(0, 20)
      : [];
    // cadence "daily" = the launch-window monitoring report: same tables and
    // narrative, but a distinct subject and NO snapshot write — snapshots stay
    // Monday-only so week-over-week trend lines compare like with like.
    const daily = body.cadence === "daily";
    const metrics = await collectMetrics();
    const html = renderReport(metrics, narrative, actionsTaken);
    const today = new Date().toISOString().slice(0, 10);
    try {
      await sendAdminEmail(
        daily
          ? `ProFarmA Daily Check-In — ${today} (rolling 7 days)`
          : `ProFarmA Weekly Review — week of ${metrics.weekStart}`,
        html,
      );
    } catch (e) {
      console.error("weekly review send failed", e);
      return json(502, { error: "Report email failed to send." });
    }
    if (!daily) await upsertSnapshot(metrics.weekStart, metrics);
    return json(200, { ok: true });
  }

  if (body.action === "signinReport") {
    // Keyed: an open endpoint here means anyone with the public anon key can
    // email-bomb the admin inbox and hammer the auth admin API. The pg_cron
    // job that fires this on Fridays passes the key.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });
    let s;
    try {
      s = await signInStatus();
    } catch (e) {
      console.error("signinReport list failed", e);
      await sendAdminEmail("[ProFarmA] Sign-in report failed", `<p>Could not read the account list: ${escHtml(String(e))}</p>`).catch(() => {});
      return json(502, { error: "Account list unavailable." });
    }
    const fmt = (ts: string | null) => ts ? new Date(ts).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT" : "—";
    const inRows = s.signedIn.map(a => `<tr><td style="padding:4px 12px 4px 0">${escHtml(a.name)}</td><td style="padding:4px 12px">${escHtml(a.email)}</td><td style="padding:4px 0;color:#2f7d5d">${escHtml(fmt(a.lastSignInAt))}</td></tr>`).join("")
      || `<tr><td colspan="3" style="padding:8px 0;color:#7a7a7a">Nobody yet.</td></tr>`;
    const outRows = s.missing.map(a => `<tr><td style="padding:4px 12px 4px 0">${escHtml(a.name)}</td><td style="padding:4px 0">${escHtml(a.email)}</td></tr>`).join("")
      || `<tr><td colspan="2" style="padding:8px 0;color:#2f7d5d">Everyone has signed in.</td></tr>`;
    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
      <div style="background:${NAVY};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">Sign-In Report</div>
        <div style="font-size:12px;color:#BEBFC3">Who has visited htlrecruit.broker since launch (${SIGNIN_LAUNCH})</div>
      </div>
      <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:20px">
        <div style="font-size:16px;margin-bottom:14px"><b>${s.signedIn.length} of ${s.total}</b> team members have signed in.</div>
        <h3 style="color:#2f7d5d;margin:0 0 6px">Signed in (${s.signedIn.length})</h3>
        <table style="border-collapse:collapse;font-size:13px">${inRows}</table>
        <h3 style="color:#a33;margin:16px 0 6px">Never visited (${s.missing.length})</h3>
        <table style="border-collapse:collapse;font-size:13px">${outRows}</table>
        ${s.missing.length ? `<div style="font-size:13px;color:#4a4a4a;margin-top:14px">Suggestion: re-send the announcement to the never-visited list, or mention it at the next team meeting.</div>` : ""}
      </div>
    </div>`;
    try {
      await sendAdminEmail(`ProFarmA Sign-In Report — ${s.signedIn.length} of ${s.total} on board`, html);
    } catch (e) {
      console.error("signinReport send failed", e);
      return json(502, { error: "Report email failed to send." });
    }
    return json(200, { ok: true });
  }

  if (body.action === "announce") {
    // Emails every launch-cohort LO their sign-in details INCLUDING the shared
    // temporary password (owner's explicit choice) — so this action is the one
    // surface that must NOT be anon-triggerable: the caller has to present the
    // ADMIN_TASK_KEY secret. Recipients come from the auth admin API, never
    // from the request.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });
    const password = Deno.env.get("SHARED_TEMP_PASSWORD");
    if (!password) return json(500, { error: "SHARED_TEMP_PASSWORD not configured." });

    let accounts: TeamAccount[];
    try {
      accounts = await cohort();
    } catch (e) {
      return json(502, { error: `Account list unavailable: ${e}` });
    }

    const sent: string[] = [], failed: string[] = [];
    for (const a of accounts) {
      const firstName = a.name.split(" ")[0];
      const html = announceHtml(firstName, a.email, password);
      try {
        await sendEmailTo(a.email, "Your HTL Recruiting Tool sign-in is ready", html);
        sent.push(a.email);
      } catch (e) {
        console.error("announce send failed", a.email, e);
        failed.push(a.email);
      }
    }
    // Receipt to the admin so the send is auditable without checking logs.
    await sendAdminEmail(
      `[ProFarmA] Announcement sent — ${sent.length} delivered${failed.length ? `, ${failed.length} FAILED` : ""}`,
      `<p>Announcement went to ${sent.length} loan officers.</p>${failed.length ? `<p style="color:#a33">Failed: ${failed.map(escHtml).join(", ")}</p>` : ""}`,
    ).catch(() => {});
    return json(200, { ok: true, sent: sent.length, failed: failed.length });
  }

  if (body.action === "notify") {
    // One-off admin notice. The recipient is fixed, but the BODY is entirely
    // caller-supplied — anyone holding the public anon key could otherwise
    // drop arbitrary HTML (fake alerts, phishing links) into the admin inbox
    // from a trusted internal sender. Keyed, like announce.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });
    const subject = `[ProFarmA] ${typeof body.subject === "string" ? body.subject.slice(0, 150) : "Notice"}`;
    const html = typeof body.html === "string" ? body.html.slice(0, 50_000) : "";
    if (!html) return json(400, { error: "html required" });
    try {
      await sendAdminEmail(subject, html);
    } catch (e) {
      console.error("notify send failed", e);
      return json(502, { error: "Notice failed to send." });
    }
    return json(200, { ok: true });
  }

  return json(400, { error: "action must be 'collect', 'send', 'notify', 'signinReport', or 'announce'." });
});
