// Supabase Edge Function: the Monday weekly review.
//
// Two-phase design so an AI session can write the narrative between phases:
//   { action: "collect" }                          → computed metrics JSON
//   { action: "send", narrative?, actionsTaken? }  → emails the report to the
//     admin + inserts the metrics_snapshots row
//   { action: "notify", subject, html }            → one-off admin notice
//     (e.g. the 72-hour sign-in report). Recipient is ALWAYS the fixed admin
//     address — never caller-controlled — so the anon-reachable surface can
//     at worst send the admin an unwanted email, never spam anyone else.
//
// Recipient: WEEKLY_REVIEW_TO secret, default jamesm@hometownlend.com.
// Email health numbers are included — this report is admin-only by audience;
// if distribution ever widens, that section must be split out.

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
  });
  if (!resp.ok) throw new Error(`Graph token ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json();
  graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return graphToken.token;
};

const sendAdminEmail = async (subject: string, html: string): Promise<void> => {
  const cfg = graphConfig();
  if (!cfg) throw new Error("Graph email is not configured.");
  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: REVIEW_TO } }],
  };
  const post = async (token: string) =>
    fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
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

// ---- Handler -----------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body: { action?: unknown; narrative?: unknown; actionsTaken?: unknown; subject?: unknown; html?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  if (body.action === "collect") {
    const metrics = await collectMetrics();
    return json(200, { ok: true, metrics });
  }

  if (body.action === "send") {
    const narrative = typeof body.narrative === "string" ? body.narrative.slice(0, 8_000) : "";
    const actionsTaken = Array.isArray(body.actionsTaken)
      ? body.actionsTaken.filter((a): a is string => typeof a === "string").slice(0, 20)
      : [];
    const metrics = await collectMetrics();
    const html = renderReport(metrics, narrative, actionsTaken);
    try {
      await sendAdminEmail(`ProFarmA Weekly Review — week of ${metrics.weekStart}`, html);
    } catch (e) {
      console.error("weekly review send failed", e);
      return json(502, { error: "Report email failed to send." });
    }
    await upsertSnapshot(metrics.weekStart, metrics);
    return json(200, { ok: true });
  }

  if (body.action === "notify") {
    // One-off admin notice. Fixed recipient; forced subject prefix so a
    // spoofed call is always recognizable as machine-generated.
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

  return json(400, { error: "action must be 'collect', 'send', or 'notify'." });
});
