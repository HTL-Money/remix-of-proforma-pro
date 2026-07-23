// Supabase Edge Function: per-recruit cinematic video via the Higgsfield API.
//
// Holds the Higgsfield API credentials server-side (HIGGSFIELD_KEY_ID /
// HIGGSFIELD_KEY_SECRET secrets) so they never reach the browser. Two actions,
// one endpoint:
//   { action: "enqueue", hash, chartPng } — starts a generation (idempotent:
//     re-enqueuing an existing hash just returns its current status, never
//     resubmits — this is the dedupe/cost-control guard).
//   { action: "status", hash } — checks progress; on completion, downloads the
//     finished clip and stores it, so future status checks (and the public
//     video_url) never depend on Higgsfield's URL staying valid.
//
// Until the secrets are set, enqueue returns 503 — the client just keeps
// showing the vault GIF, so shipping this before credentials exist is safe
// (same posture as retr-proxy before RETR credentials existed).
//
// Like retr-proxy/send-recap: verify_jwt only requires a validly signed
// project JWT and the public anon key is one, so this is deliberately
// reachable by anonymous visitors — the recap page has no login. The
// recap_hash dedupe (no client can force a resubmit of an existing hash) is
// the abuse guard against burning Higgsfield credits.
//
// NOTE ON HIGGSFIELD FIELD NAMES: built from Higgsfield's public SDK/API docs
// (platform.higgsfield.ai, image2video/dop, KEY_ID:KEY_SECRET auth). The exact
// submit-response and status-response field names aren't fully nailed down in
// public docs, so this code accepts a couple of plausible variants (request_id
// vs id; media_url vs video_url vs output[0].url) and fails loudly (logged,
// row marked "failed") rather than silently misbehaving if the real API
// returns something else. Treat the FIRST live call as the same kind of
// verify-against-reality step that fixed two real bugs in retr-proxy.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const HIGGSFIELD_BASE = "https://platform.higgsfield.ai";
const FETCH_TIMEOUT_MS = 20_000;
const STORAGE_BUCKET = "recap-videos";

const HASH_RE = /^[0-9a-f]{16}$/;
// Same posture as send-recap's other artifact checks: a fixed magic-byte
// prefix means the declared content type can never lie about the bytes.
const PNG_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_B64_PREFIX = "iVBORw0KGgo";
const MAX_PNG_B64_CHARS = 2_000_000; // ~1.5MB decoded — the real chart is ~50-200KB

// Fixed cinematic direction (Part K creative concept, locked with the user):
// carries the vault animation's grayscale-to-color motif — "where you are now
// is gray, Hometown is where it goes vivid" — into a short premium clip.
// Duration/resolution aren't set explicitly here (uncertain field names) —
// tuning those, and the prompt itself, is exactly the iteration/preview step
// the user asked for once we see real output.
const CINEMATIC_PROMPT =
  "Slow cinematic push-in on a premium financial comparison graphic. The scene " +
  "begins desaturated in cold grayscale, then smoothly transitions to rich, " +
  "vivid color as warm gold light sweeps across the frame. Subtle particle " +
  "shimmer, soft lens flare, high-end corporate motion graphics, elegant and " +
  "trustworthy, sharp detail, smooth camera motion.";

interface VideoRow {
  recap_hash: string;
  status: "processing" | "completed" | "failed";
  higgsfield_request_id: string | null;
  video_url: string | null;
}

// ---- Supabase (service role) -----------------------------------------------

const getVideoRow = async (url: string, key: string, hash: string): Promise<VideoRow | null> => {
  try {
    const r = await fetch(
      `${url}/rest/v1/recap_videos?recap_hash=eq.${hash}&select=recap_hash,status,higgsfield_request_id,video_url`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? (row as VideoRow) : null;
  } catch (e) {
    console.error("recap_videos read failed", e);
    return null;
  }
};

const upsertVideoRow = async (
  url: string,
  key: string,
  row: { recap_hash: string; status: string; higgsfield_request_id?: string | null; video_url?: string | null },
): Promise<void> => {
  try {
    await fetch(`${url}/rest/v1/recap_videos?on_conflict=recap_hash`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("recap_videos write failed (ignored)", e);
  }
};

const uploadToStorage = async (
  url: string,
  key: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> => {
  try {
    const r = await fetch(`${url}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": contentType, "x-upsert": "true" },
      body: bytes,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.error("storage upload failed", r.status, await r.text().catch(() => ""));
      return null;
    }
    return `${url}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
  } catch (e) {
    console.error("storage upload error", e);
    return null;
  }
};

// ---- Higgsfield -------------------------------------------------------------

const higgsfieldAuth = (keyId: string, keySecret: string) => `Key ${keyId}:${keySecret}`;

const submitHiggsfieldGeneration = async (keyId: string, keySecret: string, imageUrl: string): Promise<string> => {
  const r = await fetch(`${HIGGSFIELD_BASE}/v1/image2video/dop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: higgsfieldAuth(keyId, keySecret) },
    body: JSON.stringify({ image_url: imageUrl, prompt: CINEMATIC_PROMPT, model: "DOP_TURBO" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await r.json().catch(() => null)) as { request_id?: string; id?: string } | null;
  const requestId = body?.request_id ?? body?.id;
  if (!r.ok || typeof requestId !== "string" || !requestId) {
    throw new Error(`Higgsfield submit failed (${r.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return requestId;
};

const checkHiggsfieldStatus = async (
  keyId: string,
  keySecret: string,
  requestId: string,
): Promise<{ done: boolean; failed: boolean; mediaUrl?: string }> => {
  const r = await fetch(`${HIGGSFIELD_BASE}/requests/${encodeURIComponent(requestId)}/status`, {
    headers: { Authorization: higgsfieldAuth(keyId, keySecret) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await r.json().catch(() => null)) as
    | { status?: string; state?: string; media_url?: string; video_url?: string; output?: { url?: string }[] }
    | null;
  const status = (body?.status ?? body?.state ?? "").toLowerCase();
  if (status === "failed" || status === "nsfw") return { done: false, failed: true };
  if (status === "completed") {
    const mediaUrl = body?.media_url ?? body?.video_url ?? body?.output?.[0]?.url;
    if (!mediaUrl) return { done: false, failed: true }; // completed with no media = treat as failed
    return { done: true, failed: false, mediaUrl };
  }
  return { done: false, failed: false }; // queued / in_progress
};

// ---- Handler ----------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const keyId = Deno.env.get("HIGGSFIELD_KEY_ID") ?? "";
  const keySecret = Deno.env.get("HIGGSFIELD_KEY_SECRET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let body: { action?: unknown; hash?: unknown; chartPng?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const hash = body.hash;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return json(400, { error: "Invalid recap hash." });

  if (body.action === "status") {
    const row = await getVideoRow(supabaseUrl, serviceKey, hash);
    if (!row) return json(200, { status: "unknown" });
    if (row.status === "completed") return json(200, { status: "completed", url: row.video_url });
    if (row.status === "failed") return json(200, { status: "failed" });
    // Still processing — actually poll Higgsfield (this is what drives progress
    // forward; there's no background worker, so the client's own poll cadence
    // IS the poll loop).
    if (!keyId || !keySecret || !row.higgsfield_request_id) return json(200, { status: "processing" });
    try {
      const check = await checkHiggsfieldStatus(keyId, keySecret, row.higgsfield_request_id);
      if (check.failed) {
        await upsertVideoRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "failed" });
        return json(200, { status: "failed" });
      }
      if (check.done && check.mediaUrl) {
        const mp4 = await fetch(check.mediaUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!mp4.ok) return json(200, { status: "processing" }); // transient — next poll retries
        const bytes = new Uint8Array(await mp4.arrayBuffer());
        const publicUrl = await uploadToStorage(supabaseUrl, serviceKey, `${hash}.mp4`, bytes, "video/mp4");
        if (!publicUrl) return json(200, { status: "processing" });
        await upsertVideoRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "completed", video_url: publicUrl });
        return json(200, { status: "completed", url: publicUrl });
      }
      return json(200, { status: "processing" });
    } catch (e) {
      console.error("higgsfield status check failed (treated as still-processing)", e);
      return json(200, { status: "processing" });
    }
  }

  if (body.action === "enqueue") {
    if (!keyId || !keySecret) return json(503, { error: "Cinematic video isn't enabled yet." });
    const existing = await getVideoRow(supabaseUrl, serviceKey, hash);
    if (existing) return json(200, { status: existing.status, url: existing.video_url ?? undefined }); // dedupe — never resubmit

    const chartPng = body.chartPng;
    if (
      typeof chartPng !== "string" ||
      chartPng.length === 0 ||
      chartPng.length > MAX_PNG_B64_CHARS ||
      chartPng.length % 4 !== 0 ||
      !PNG_B64_RE.test(chartPng) ||
      !chartPng.startsWith(PNG_B64_PREFIX)
    ) {
      return json(400, { error: "Invalid source image." });
    }

    try {
      const imageBytes = Uint8Array.from(atob(chartPng), c => c.charCodeAt(0));
      const imageUrl = await uploadToStorage(supabaseUrl, serviceKey, `${hash}-source.png`, imageBytes, "image/png");
      if (!imageUrl) return json(502, { error: "Couldn't stage the source image." });
      const requestId = await submitHiggsfieldGeneration(keyId, keySecret, imageUrl);
      await upsertVideoRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "processing", higgsfield_request_id: requestId });
      return json(200, { status: "processing" });
    } catch (e) {
      console.error("higgsfield enqueue failed", e);
      await upsertVideoRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "failed" });
      return json(502, { error: "Couldn't start the cinematic render." });
    }
  }

  return json(400, { error: "action must be 'enqueue' or 'status'." });
});
