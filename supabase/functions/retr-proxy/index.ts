// Supabase Edge Function: proxy for RETR's loan-officer-stats API.
//
// Holds the RETR OAuth2 client credentials server-side (RETR_CLIENT_ID /
// RETR_CLIENT_SECRET secrets) so they never reach the browser, handles the
// authenticate/refresh token dance, and caches results in retr_stats_cache
// (24h per NMLS+range) so repeat lookups don't burn RETR's rate limit.
//
// Until the secrets are set this returns 503 with a friendly message — the
// client treats that as "no live data" and falls back to the shared report
// store / manual entry, so shipping this before credentials exist is safe.
//
// Like send-recap: verify_jwt only requires a validly signed project JWT and
// the public anon key is one, so this is deliberately reachable by anonymous
// visitors — the LO self-serve flow is the point. The cache plus the daily
// upstream budget below are the abuse guards protecting RETR's rate limit.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const RETR_BASE = "https://retrapi.com";
const VALID_RANGES = new Set([3, 6, 12, 14]);
const DEFAULT_RANGE = 6;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Upstream calls allowed per rolling 24h (counted as cache rows fetched in
// that window — an approximation, but errs on the safe side). RETR quoted
// rate limits but no hard number yet; sized for the ~20-50/day we told them,
// with headroom. Raise once RETR confirms the real limit.
const UPSTREAM_DAILY_BUDGET = 150;
const FETCH_TIMEOUT_MS = 15_000;

interface RetrEnvelope<T> { error?: boolean; success?: boolean; message?: string | null; data?: T | null }

// Module-level token cache — survives across requests within a warm instance.
let tok: { accessToken: string; refreshToken: string | null; expiresAt: number } | null = null;

const storeToken = (b: { accessToken: string; refreshToken?: string; expiresIn?: number }) => {
  tok = {
    accessToken: b.accessToken,
    refreshToken: b.refreshToken ?? null,
    // Refresh a minute early so a token never expires mid-request.
    expiresAt: Date.now() + Math.max(60, (b.expiresIn ?? 3600) - 60) * 1000,
  };
};

// RETR wraps every response in an envelope: { error, success, message, data,
// correlationId } — the tokens live under data (verified live 2026-07-23).
const unwrapAuth = (b: unknown): { accessToken: string; refreshToken?: string; expiresIn?: number } | null => {
  const env = b as { success?: boolean; data?: { accessToken?: string; refreshToken?: string; expiresIn?: number } } | null;
  const d = env?.data;
  return env?.success && d?.accessToken ? (d as { accessToken: string; refreshToken?: string; expiresIn?: number }) : null;
};

const authenticate = async (clientId: string, secret: string): Promise<void> => {
  const r = await fetch(`${RETR_BASE}/api/authapi/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ClientId: clientId, Secret: secret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const auth = unwrapAuth(await r.json().catch(() => null));
  if (!r.ok || !auth) throw new Error(`RETR authentication failed (${r.status})`);
  storeToken(auth);
};

const tryRefresh = async (clientId: string): Promise<boolean> => {
  if (!tok?.refreshToken) return false;
  try {
    const r = await fetch(`${RETR_BASE}/api/AuthApi/refresh-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ClientId: clientId, RefreshToken: tok.refreshToken }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const auth = unwrapAuth(await r.json().catch(() => null));
    if (!r.ok || !auth) return false;
    storeToken(auth);
    return true;
  } catch {
    return false;
  }
};

const getAccessToken = async (clientId: string, secret: string): Promise<string> => {
  if (tok && Date.now() < tok.expiresAt) return tok.accessToken;
  if (await tryRefresh(clientId)) return tok!.accessToken;
  await authenticate(clientId, secret);
  return tok!.accessToken;
};

// ---- Cache (service role; both directions fail open — a cache outage must
// never take down lookups, it just costs an upstream call) ------------------

const cacheGet = async (url: string, key: string, nmlsId: number, range: number) => {
  try {
    const r = await fetch(
      `${url}/rest/v1/retr_stats_cache?nmls_id=eq.${nmlsId}&date_range=eq.${range}&select=data,fetched_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    if (Date.now() - new Date(row.fetched_at).getTime() > CACHE_TTL_MS) return null;
    return row as { data: unknown; fetched_at: string };
  } catch (e) {
    console.error("cache read failed (fail-open)", e);
    return null;
  }
};

const cachePut = async (url: string, key: string, nmlsId: number, range: number, data: unknown) => {
  try {
    await fetch(`${url}/rest/v1/retr_stats_cache?on_conflict=nmls_id,date_range`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ nmls_id: nmlsId, date_range: range, data, fetched_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("cache write failed (ignored)", e);
  }
};

/** True if we're still under the rolling-24h upstream budget. Fails open. */
const withinUpstreamBudget = async (url: string, key: string): Promise<boolean> => {
  try {
    const since = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const r = await fetch(
      `${url}/rest/v1/retr_stats_cache?select=nmls_id&fetched_at=gte.${encodeURIComponent(since)}`,
      { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    const range = r.headers.get("content-range");
    const count = range ? Number(range.split("/")[1]) : NaN;
    return !Number.isFinite(count) || count < UPSTREAM_DAILY_BUDGET;
  } catch (e) {
    console.error("budget check failed (fail-open)", e);
    return true;
  }
};

// ---- Handler ---------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const clientId = Deno.env.get("RETR_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("RETR_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    return json(503, { error: "Live RETR lookup isn't enabled yet." });
  }

  let body: { nmlsId?: unknown; dateRange?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const nmlsId = body.nmlsId;
  if (typeof nmlsId !== "number" || !Number.isInteger(nmlsId) || nmlsId < 1 || nmlsId > 2147483647) {
    return json(400, { error: "nmlsId must be a positive integer." });
  }
  const dateRange = body.dateRange === undefined ? DEFAULT_RANGE : body.dateRange;
  if (typeof dateRange !== "number" || !VALID_RANGES.has(dateRange)) {
    return json(400, { error: "dateRange must be one of 3, 6, 12, 14." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  const cached = await cacheGet(supabaseUrl, serviceKey, nmlsId, dateRange);
  if (cached) return json(200, { ok: true, data: cached.data, cached: true, fetchedAt: cached.fetched_at });

  if (!(await withinUpstreamBudget(supabaseUrl, serviceKey))) {
    return json(429, { error: "Daily RETR lookup limit reached — try again tomorrow." });
  }

  try {
    let token = await getAccessToken(clientId, clientSecret);
    let r = await fetch(`${RETR_BASE}/api/loanofficer/loan-officer-stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nmlsId, dateRange }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (r.status === 401) {
      // Stale/revoked token — re-authenticate once and retry.
      tok = null;
      token = await getAccessToken(clientId, clientSecret);
      r = await fetch(`${RETR_BASE}/api/loanofficer/loan-officer-stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ nmlsId, dateRange }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }
    if (r.status === 429) {
      return json(429, { error: "RETR's rate limit was reached — try again shortly." });
    }
    const envelope = (await r.json().catch(() => null)) as RetrEnvelope<unknown> | null;
    // RETR signals "no LO matches this NMLS" as HTTP 422 with a well-formed
    // envelope (verified live) — that's a normal empty result, not an outage.
    // Treat any parseable error-envelope as no-data so a recruit typing an
    // unknown NMLS gets a friendly message instead of a scary failure; only a
    // truly unparseable / non-envelope response is a hard 502.
    if (envelope && (envelope.error || envelope.success === false || !envelope.data)) {
      return json(200, { ok: true, data: null, message: envelope.message ?? "No RETR data found for this NMLS." });
    }
    if (!r.ok || !envelope) {
      console.error("RETR stats call failed", r.status, envelope?.message);
      return json(502, { error: `RETR lookup failed (${r.status}).` });
    }
    const fetchedAt = new Date().toISOString();
    await cachePut(supabaseUrl, serviceKey, nmlsId, dateRange, envelope.data);
    return json(200, { ok: true, data: envelope.data, cached: false, fetchedAt });
  } catch (e) {
    console.error("retr-proxy error", e);
    return json(502, { error: "Couldn't reach RETR — try again shortly." });
  }
});
