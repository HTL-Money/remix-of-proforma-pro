// Supabase Edge Function: the Monday weekly review.
//
// Two-phase design so an AI session can write the narrative between phases:
//   { action: "collect", key? }                    → computed metrics JSON;
//     without the key, recruit emails and NMLS numbers are redacted out
//   { action: "send", narrative?, actionsTaken?, cadence? }  → emails the
//     report to the admin; cadence "daily" (the 21-day launch monitoring
//     window) skips the snapshot write so trend rows stay Monday-only
//   { action: "signinReport", key }                → adoption report: who has
//     set their own password and who is still on the temporary one
//   { action: "announce", key }                    → the LO rollout email
//     (sign-in details + shared temp password) to every cohort member
//   { action: "announce", key, invite }            → the same email to ONE
//     existing account, with a password minted for that person alone. How a
//     new hire gets their login without re-mailing the cohort.
//   { action: "announce", key, previewTo }         → the genuine template to an
//     admin address only. Changes nothing; for reviewing copy before a send.
//   { action: "remind", key, dryRun? }             → the Mon–Sat nudge to
//     everyone still holding a temporary password. Carries no password.
//     Recipients are derived from adoption state, so it stops for each person
//     automatically. Sundays are deliberately skipped (owner's call).
//   { action: "notify", key, subject, html }       → one-off admin notice
//
// `verify_jwt` is on, but the anon key it accepts ships in the browser bundle,
// so it is NOT an authorization signal: every action that sends mail with
// caller-supplied content, or to anyone other than the admin, additionally
// requires ADMIN_TASK_KEY (see adminKeyOk). Admin recipient: WEEKLY_REVIEW_TO
// secret, default jamesm@hometownlend.com. Email health numbers make the
// weekly report admin-only by audience; if distribution ever widens, that
// section must be split out.

import { inCohort, splitAdoption, type Adoption, type TeamAccount } from "./adoption.ts";

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
  // Everything this function sends is signed "James Mowery, Director of
  // Sales", so it must also COME from his mailbox — the announcement went out
  // from aryanj@ (RECAP_SENDER) in rehearsal and the owner caught it. The
  // Graph app has tenant-wide Mail.Send, so the sender is just config.
  const sender = Deno.env.get("ANNOUNCE_SENDER") || Deno.env.get("RECAP_SENDER");
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


// TeamAccount, ANNOUNCED_AT and splitAdoption live in ./adoption.ts so they can
// be unit-tested without a Deno runtime (same split as send-recap/sourcing.ts).

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
    const data = await r.json() as { users?: { id?: string; email?: string; created_at?: string; last_sign_in_at?: string | null; user_metadata?: { full_name?: string }; app_metadata?: { must_set_password?: unknown } }[] };
    const users = data.users ?? [];
    for (const u of users) {
      if (!u.email) continue;
      out.push({
        id: u.id ?? "",
        email: u.email.toLowerCase(),
        name: u.user_metadata?.full_name ?? u.email.split("@")[0],
        createdAt: u.created_at ?? "",
        lastSignInAt: u.last_sign_in_at ?? null,
        // Strict === true, matching the client gate in src/lib/auth.tsx: a
        // stray "false" string or a 1 must not read as "still pending".
        mustSetPassword: u.app_metadata?.must_set_password === true,
      });
    }
    if (users.length < 100) break;
  }
  return out;
};


/** The rollout cohort: accounts provisioned on launch day, minus the
 *  exclusions. Both the announcement and the adoption report use this. */
const cohort = async (): Promise<TeamAccount[]> =>
  (await listTeamAccounts()).filter(inCohort);

/** Looks one account up by address, case-insensitively. Returns the row from
 *  auth.users — so every later use (who we mail, whose password we set) comes
 *  from Supabase's own record and not from the caller's string. */
const findAccount = async (email: string): Promise<TeamAccount | null> => {
  const want = email.trim().toLowerCase();
  return (await listTeamAccounts()).find(a => a.email === want) ?? null;
};

/** The admin roster, read live from the same table `is_admin()` uses, so the
 *  preview allow-list can never drift from who is actually an admin. */
const adminEmails = async (): Promise<Set<string>> => {
  const rows = await rest("app_admins?select=email") as { email?: string }[];
  const set = new Set(rows.map(r => (r.email ?? "").toLowerCase()).filter(Boolean));
  set.add(REVIEW_TO.toLowerCase()); // the fixed report recipient always qualifies
  return set;
};

// Word-plus-symbol shape rather than raw base64: this password gets read off a
// screen and typed once. Must satisfy the Auth policy (12+ chars, upper, lower,
// digit, symbol) and survive the leaked-password check, which random word
// triples comfortably do.
const PW_WORDS = [
  "harbor", "granite", "meadow", "compass", "lantern", "prairie", "summit", "anchor",
  "copper", "juniper", "canyon", "beacon", "timber", "orchard", "quarry", "ridge",
];
const mintPassword = (): string => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const word = (i: number) => {
    const w = PW_WORDS[bytes[i] % PW_WORDS.length];
    return w[0].toUpperCase() + w.slice(1);
  };
  const digits = String(1000 + ((bytes[3] << 8 | bytes[4]) % 9000));
  const symbol = "!@#$%&?"[bytes[5] % 7];
  return `${word(0)}-${word(1)}-${word(2)}${digits}${symbol}`;
};

/** Sets a password on an existing account via the auth admin API. */
/** Sets a password on an existing account via the auth admin API, and stamps
 *  the flag the client gate reads. A minted password is still a password
 *  someone else generated and sent over email, so the invite path has to force
 *  a change exactly like the shared-password rollout did — otherwise every new
 *  hire after launch day quietly arrives ungated while the original cohort is
 *  gated, which is the kind of gap nobody notices until it matters. */
const setPassword = async (id: string, password: string): Promise<void> => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service credentials missing.");
  const r = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password, email_confirm: true, app_metadata: { must_set_password: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`admin set password ${r.status}: ${await r.text().catch(() => "")}`);
};

/** Adoption split across the cohort. */
const adoptionStatus = async (): Promise<Adoption> => splitAdoption(await cohort());

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

  type L = { token: string; created_by: string; created_at: string; use_count: number; last_used_at: string | null; recruit_email: string | null };
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
    signIns: await adoptionStatus()
      .then(s => ({ signedIn: s.activated.length, total: s.total, missing: s.pending.map(a => a.name) }))
      .catch(e => { console.error("signIns unavailable", e); return null; }),
  };
};

// ---- Report rendering --------------------------------------------------------

const NAVY = "#13294B";

const kpiRow = (label: string, week: number, prior: number): string => {
  const delta = prior === 0 ? (week > 0 ? "new" : "—") : `${week >= prior ? "+" : ""}${(((week - prior) / prior) * 100).toFixed(0)}%`;
  return `<tr><td style="padding:6px 12px 6px 0;color:#4a4a4a">${escHtml(label)}</td><td style="padding:6px 12px;font-weight:600">${week}</td><td style="padding:6px 12px;color:#7a7a7a">prev ${prior}</td><td style="padding:6px 0;color:${week >= prior ? "#2f7d5d" : "#a33"}">${delta}</td></tr>`;
};

// The real shape of collectMetrics()'s return, without hand-duplicating every
// field it computes — derived so a field rename here is a compile error at
// both call sites instead of a silently-any pass-through.
type Metrics = Awaited<ReturnType<typeof collectMetrics>>;

const renderReport = (m: Metrics, narrative: string, actionsTaken: string[]): string => {
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
      <div style="font-size:14px"><b>${m.signIns.signedIn} of ${m.signIns.total}</b> have set their own password.</div>
      ${m.signIns.missing.length ? `<div style="font-size:13px;color:#4a4a4a;margin-top:4px">Still on the temporary one: ${(m.signIns.missing as string[]).map(escHtml).join(", ")}</div>` : ""}` : ""}
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

// `shared` distinguishes the launch cohort (everyone got one team-wide temporary
// password, so the copy has to say so and push them to change it) from a
// single new hire, who gets a password minted for them alone. Same template
// either way — one body of copy that can drift from itself is worse than a
// conditional.
const announceHtml = (firstName: string, email: string, password: string, shared = true): string => `
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
      <b>The moment you sign in, you'll be asked to set your own password.</b>
      That's one screen, then you're in${shared
        ? " — the password below is shared across the whole team, so it stops being yours the second anyone else uses it."
        : " — the password below was generated just for you and is only meant to get you in the door."}
    </p>
    <p style="margin:0 0 12px;font-size:13px;color:#4a4a4a">
      Locked out later? <b>Forgot your password?</b> on the sign-in page emails you
      a reset link — you never have to wait on anyone for it.
    </p>
    <p style="margin:0 0 12px">
      Then open <b>Recruit Links</b> to grab your personal link or send a pro
      forma directly. Questions — reply to this email or grab James.
    </p>
    <p style="margin:16px 0 0;color:#4a4a4a">— James Mowery, Director of Sales</p>
  </div>
</div>`;

/** The daily nudge to someone still on the temporary password.
 *
 *  Deliberately carries NO password. They already hold one, and a credential
 *  repeated in a daily email is a standing liability — if they've lost it,
 *  "Forgot your password?" is the safe path and it's right there on the
 *  sign-in page. Short on purpose: this arrives most mornings until they act,
 *  so it has to stay easy to ignore-then-do rather than feel like a scolding. */
const remindHtml = (firstName: string): string => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:${NAVY};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
    <div style="font-size:18px;font-weight:700">Two minutes to finish setting up</div>
  </div>
  <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:20px">
    <p style="margin:0 0 12px">Hi ${escHtml(firstName)},</p>
    <p style="margin:0 0 12px">
      Your Hometown Lending recruiting tool account is ready, but it still has the
      temporary password we sent you. Sign in, pick your own password, and you're done.
    </p>
    <p style="margin:16px 0">
      <a href="https://htlrecruit.broker/links" style="background:${NAVY};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;display:inline-block">Finish setting up</a>
    </p>
    <p style="margin:0 0 12px">
      Once you're in, it builds a personalized pro forma for any loan officer you're
      recruiting — their real numbers at HTL — and emails it to them with your name on it.
      Anyone who comes through your link is attached to you for HTL5 rev share.
    </p>
    <p style="margin:0;font-size:12px;color:#7a7a7a">
      Lost the temporary password? Use <b>Forgot your password?</b> on the sign-in page.
      You'll stop getting this note as soon as you've set your own.
    </p>
    <p style="margin:16px 0 0;color:#4a4a4a">— James Mowery, Director of Sales</p>
  </div>
</div>`;

// ---- Handler -----------------------------------------------------------------

/** Strips recruit-identifying fields from a metrics bundle, leaving the counts
 *  and the team-side names a narrative needs. Used for unkeyed `collect`. */
const redactPeople = (m: Metrics) => ({
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

  // Every field the handler reads must be declared, or tsc silently green-lights
  // a typo. The report body once rendered fields splitAdoption no longer
  // returned; esbuild stripped the types without checking them and it only
  // surfaced as a 500 in production.
  let body: {
    action?: unknown; narrative?: unknown; actionsTaken?: unknown; subject?: unknown;
    html?: unknown; cadence?: unknown; key?: unknown;
    invite?: unknown; previewTo?: unknown; dryRun?: unknown;
  };
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
    // job (adoption-report-mon-sat, 13:00 UTC Mon–Sat) passes the key.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });
    let s;
    try {
      s = await adoptionStatus();
    } catch (e) {
      console.error("signinReport list failed", e);
      await sendAdminEmail("[ProFarmA] Adoption report failed", `<p>Could not read the account list: ${escHtml(String(e))}</p>`).catch(() => {});
      return json(502, { error: "Account list unavailable." });
    }
    const fmt = (ts: string | null) => ts ? new Date(ts).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT" : "—";
    // The chase list leads, numbered, because it is the part the owner acts on
    // — built to be lifted straight out of the email rather than retyped.
    const pendRows = s.pending.map((a, i) => `<tr>
        <td style="padding:4px 8px 4px 0;color:#9a9a9a">${i + 1}</td>
        <td style="padding:4px 12px 4px 0">${escHtml(a.name)}</td>
        <td style="padding:4px 12px 4px 0"><a href="mailto:${escHtml(a.email)}" style="color:${NAVY}">${escHtml(a.email)}</a></td>
        <td style="padding:4px 0;color:${a.opened ? "#b06a00" : "#a33"}">${a.opened ? "opened it, stalled" : "never opened"}</td>
      </tr>`).join("")
      || `<tr><td colspan="4" style="padding:8px 0;color:#2f7d5d">Everyone has set their own password.</td></tr>`;
    const doneRows = s.activated.map(a => `<tr><td style="padding:4px 12px 4px 0">${escHtml(a.name)}</td><td style="padding:4px 12px">${escHtml(a.email)}</td><td style="padding:4px 0;color:#2f7d5d">${escHtml(fmt(a.lastSignInAt))}</td></tr>`).join("")
      || `<tr><td colspan="3" style="padding:8px 0;color:#7a7a7a">Nobody yet.</td></tr>`;
    const pct = s.total ? Math.round((s.activated.length / s.total) * 100) : 0;
    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a">
      <div style="background:${NAVY};color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:18px;font-weight:700">Pro Forma Adoption</div>
        <div style="font-size:12px;color:#BEBFC3">Measured by who has set their own password — not by sign-ins</div>
      </div>
      <div style="border:1px solid #e3e3e3;border-top:0;border-radius:0 0 8px 8px;padding:20px">
        <div style="font-size:16px;margin-bottom:4px"><b>${s.activated.length} of ${s.total}</b> are fully set up (${pct}%).</div>
        <div style="font-size:13px;color:#4a4a4a;margin-bottom:16px">
          ${s.pending.length} still on the temporary password — ${s.openedButStalled.length} opened it and stopped at the
          password screen, ${s.neverOpened.length} have not opened it at all. Each gets an automatic reminder every
          morning except Sunday until they finish, and drops off this list the moment they do.
        </div>
        <h3 style="color:#a33;margin:0 0 6px">Still need to set a password (${s.pending.length})</h3>
        <table style="border-collapse:collapse;font-size:13px;width:100%">${pendRows}</table>
        <h3 style="color:#2f7d5d;margin:20px 0 6px">Done (${s.activated.length})</h3>
        <table style="border-collapse:collapse;font-size:13px">${doneRows}</table>
      </div>
    </div>`;
    try {
      await sendAdminEmail(`ProFarmA Adoption — ${s.activated.length} of ${s.total} set up, ${s.pending.length} outstanding`, html);
    } catch (e) {
      console.error("signinReport send failed", e);
      return json(502, { error: "Report email failed to send." });
    }
    return json(200, { ok: true, activated: s.activated.length, pending: s.pending.length });
  }

  if (body.action === "announce") {
    // Emails every launch-cohort LO their sign-in details INCLUDING the shared
    // temporary password (owner's explicit choice) — so this action is the one
    // surface that must NOT be anon-triggerable: the caller has to present the
    // ADMIN_TASK_KEY secret. Recipients come from the auth admin API, never
    // from the request.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });

    const invite = typeof body.invite === "string" ? body.invite : null;
    const previewTo = typeof body.previewTo === "string" ? body.previewTo : null;
    // Three distinct blast radii share this action. Refuse rather than guess
    // which one a caller with both fields set meant — the wrong guess either
    // mails 39 people or resets a real password.
    if (invite && previewTo) return json(400, { error: "Set at most one of 'invite' or 'previewTo'." });

    // ---- Preview: the genuine template to an admin, nothing else touched ----
    if (previewTo) {
      let allowed: Set<string>;
      try {
        allowed = await adminEmails();
      } catch (e) {
        return json(502, { error: `Admin roster unavailable: ${e}` });
      }
      const to = previewTo.trim().toLowerCase();
      // Admin-only, so this can never become a way to mail the announcement —
      // and the temporary password inside it — to an arbitrary address.
      if (!allowed.has(to)) return json(403, { error: "Preview recipient must be an admin." });
      const shared = Deno.env.get("SHARED_TEMP_PASSWORD");
      if (!shared) return json(500, { error: "SHARED_TEMP_PASSWORD not configured." });
      try {
        await sendEmailTo(to, "[Preview] Your HTL Recruiting Tool sign-in is ready", announceHtml("James", to, shared));
      } catch (e) {
        console.error("announce preview failed", e);
        return json(502, { error: "Preview failed to send." });
      }
      return json(200, { ok: true, preview: to });
    }

    // ---- Invite: one new hire, with a password minted for them alone --------
    if (invite) {
      let account: TeamAccount | null;
      try {
        account = await findAccount(invite);
      } catch (e) {
        return json(502, { error: `Account lookup failed: ${e}` });
      }
      // The account has to exist first: this action invites, it does not
      // provision. Creating logins is a deliberate, separate act.
      if (!account || !account.id) return json(404, { error: "No account for that address — create it first." });

      const fresh = mintPassword();
      try {
        await setPassword(account.id, fresh);
      } catch (e) {
        console.error("invite password set failed", e);
        return json(502, { error: "Could not set a temporary password." });
      }
      try {
        // account.email, never `invite` — the address is Supabase's record of
        // the account, so a typo'd or spoofed input cannot redirect the mail.
        await sendEmailTo(account.email, "Your HTL Recruiting Tool sign-in is ready",
          announceHtml(account.name.split(" ")[0], account.email, fresh, false));
      } catch (e) {
        console.error("invite send failed", account.email, e);
        // The password was already changed, so say so plainly: the account is
        // now holding a credential nobody received.
        return json(502, { error: "Password was reset but the email failed to send — resend or reset again." });
      }
      await sendAdminEmail(
        `[ProFarmA] Invite sent — ${account.email}`,
        `<p>${escHtml(account.email)} was emailed sign-in details with a freshly generated temporary password.</p>`,
      ).catch(() => {});
      return json(200, { ok: true, invited: account.email });
    }

    // ---- Default: the launch cohort, shared temporary password --------------
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

  if (body.action === "remind") {
    // Same key as announce: this mails a slice of the team on a schedule, so
    // it must never be reachable with the public anon key alone.
    if (!adminKeyOk(body.key)) return json(403, { error: "Forbidden." });

    let s;
    try {
      s = await adoptionStatus();
    } catch (e) {
      console.error("remind list failed", e);
      return json(502, { error: `Account list unavailable: ${e}` });
    }

    // Recipients are derived, never supplied. Anyone who has set their own
    // password is simply not in `pending`, so the reminder stops on its own —
    // there is no separate opt-out list that could drift out of sync.
    const targets = s.pending;
    if (body.dryRun === true) {
      return json(200, { ok: true, dryRun: true, wouldEmail: targets.length, recipients: targets.map(a => a.email) });
    }

    const sent: string[] = [], failed: string[] = [];
    for (const a of targets) {
      try {
        await sendEmailTo(a.email, "Finish setting up your Pro Forma sign-in", remindHtml(a.name.split(" ")[0]));
        sent.push(a.email);
      } catch (e) {
        console.error("remind send failed", a.email, e);
        failed.push(a.email);
      }
    }
    if (sent.length || failed.length) {
      await sendAdminEmail(
        `[ProFarmA] Setup reminder — ${sent.length} nudged${failed.length ? `, ${failed.length} FAILED` : ""}`,
        `<p>Reminded ${sent.length} of ${s.total} who still hold the temporary password.</p>` +
        `${failed.length ? `<p style="color:#a33">Failed: ${failed.map(escHtml).join(", ")}</p>` : ""}`,
      ).catch(() => {});
    }
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

  return json(400, { error: "action must be 'collect', 'send', 'notify', 'signinReport', 'announce', or 'remind'." });
});
