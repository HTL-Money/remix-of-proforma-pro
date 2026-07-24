// Supabase Edge Function: per-recruit Gamma presentation.
//
// Holds the Gamma API key server-side (GAMMA_API_KEY secret) so it never
// reaches the browser. Two actions:
//   { action: "enqueue", hash, recap } — starts a generation (dedupe-guarded:
//     an existing hash never resubmits — the cost/abuse control).
//   { action: "status", hash } — drives Gamma's own async job forward on each
//     call (there's no background worker; the client's poll cadence IS the
//     poll loop), storing the final presentation URL once ready.
//
// Until GAMMA_API_KEY is set, enqueue returns 503 — the client just keeps
// showing the recap numbers, so shipping this before the key exists is safe
// (same posture as retr-proxy before RETR credentials existed).
//
// NOTE ON GAMMA'S RESPONSE SHAPE: the REQUEST shape below (inputText/
// textMode/format/numCards) is verified against Gamma's own public docs
// (github.com/gamma-app/gamma-docs). The exact submit/poll RESPONSE field
// names weren't retrievable (docs site blocked automated fetch), so this
// code accepts a couple of plausible variants and fails loudly (logged, row
// marked "failed") rather than silently misbehaving if the real API differs
// — treat the first real call as the verification step, same as RETR/
// Higgsfield needed.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GAMMA_BASE = "https://public-api.gamma.app/v1.0";
const FETCH_TIMEOUT_MS = 20_000;
const HASH_RE = /^[0-9a-f]{16}$/;

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    isFinite(n) ? n : 0,
  );

// "You Already Know" — chosen because the earlier persona-review panel found
// this audience (skeptical, financially sophisticated loan officers) reacts
// against hype-toned pitches; this reads as "just the math," not a sales
// pitch. Built from RecapPayload's numbers only — never employee data (there
// is none in RecapPayload), never the HTL5 sourcing info (that's backend-only
// and never touches anything sent to the recipient).
interface RecapForPrompt {
  loName?: string;
  current?: { annual?: number | null } | null;
  htl?: { annual?: number } | null;
  gain?: { annual?: number | null } | null;
  volume?: number;
  files?: number;
}

const buildInputText = (recap: RecapForPrompt): string => {
  const name = recap.loName || "you";
  const current = recap.current?.annual ?? null;
  const htl = recap.htl?.annual ?? 0;
  const gain = recap.gain?.annual ?? null;
  const hasComparison = current != null && gain != null;
  const gainLine = hasComparison
    ? `The gap: ${usd(gain ?? 0)} a year — ${usd(current ?? 0)} today vs. ${usd(htl)} at Hometown Lending.`
    : `Projected annual comp at Hometown Lending: ${usd(htl)}.`;
  return [
    `Create a short, restrained, premium mortgage-industry presentation for a loan officer named ${name}.`,
    `Tone: direct and factual, NOT hype or sales-pitchy — this audience is financially sophisticated and skeptical of hype.`,
    `Headline concept: "You already know you're leaving money on the table. Here's exactly how much."`,
    gainLine,
    `Production: ${recap.files ?? 0} files, ${usd(recap.volume ?? 0)} in annual volume — same production, different split.`,
    `Close with a low-pressure invitation to a short, no-commitment call — never claim these figures are guaranteed; they are illustrative.`,
    `Brand colors: deep navy (#13294B), muted sage green (#4F8F77). Clean, restrained, trustworthy — not flashy.`,
  ].join(" ");
};

interface PresentationRow {
  recap_hash: string;
  status: "processing" | "completed" | "failed";
  gamma_generation_id: string | null;
  presentation_url: string | null;
}

const getRow = async (url: string, key: string, hash: string): Promise<PresentationRow | null> => {
  try {
    const r = await fetch(
      `${url}/rest/v1/recap_presentations?recap_hash=eq.${hash}&select=recap_hash,status,gamma_generation_id,presentation_url`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? (row as PresentationRow) : null;
  } catch (e) {
    console.error("recap_presentations read failed", e);
    return null;
  }
};

const upsertRow = async (
  url: string,
  key: string,
  row: { recap_hash: string; status: string; gamma_generation_id?: string | null; presentation_url?: string | null },
): Promise<void> => {
  try {
    await fetch(`${url}/rest/v1/recap_presentations?on_conflict=recap_hash`, {
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
    console.error("recap_presentations write failed (ignored)", e);
  }
};

const submitGammaGeneration = async (apiKey: string, inputText: string): Promise<string> => {
  const r = await fetch(`${GAMMA_BASE}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ inputText, textMode: "generate", format: "presentation", numCards: 6 }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await r.json().catch(() => null)) as
    | { generationId?: string; id?: string; gammaId?: string }
    | null;
  const genId = body?.generationId ?? body?.id ?? body?.gammaId;
  if (!r.ok || typeof genId !== "string" || !genId) {
    throw new Error(`Gamma submit failed (${r.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return genId;
};

const checkGammaStatus = async (
  apiKey: string,
  generationId: string,
): Promise<{ done: boolean; failed: boolean; url?: string }> => {
  const r = await fetch(`${GAMMA_BASE}/generations/${encodeURIComponent(generationId)}`, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await r.json().catch(() => null)) as
    | { status?: string; state?: string; gammaUrl?: string; url?: string; previewUrl?: string }
    | null;
  const status = (body?.status ?? body?.state ?? "").toLowerCase();
  if (status === "failed" || status === "error") return { done: false, failed: true };
  if (status === "completed" || status === "success" || status === "done") {
    const url = body?.gammaUrl ?? body?.url ?? body?.previewUrl;
    if (!url) return { done: false, failed: true }; // completed with no URL = treat as failed
    return { done: true, failed: false, url };
  }
  return { done: false, failed: false }; // pending / processing / generating
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const apiKey = Deno.env.get("GAMMA_API_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let body: { action?: unknown; hash?: unknown; recap?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const hash = body.hash;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return json(400, { error: "Invalid recap hash." });

  if (body.action === "status") {
    const row = await getRow(supabaseUrl, serviceKey, hash);
    if (!row) return json(200, { status: "unknown" });
    if (row.status === "completed") return json(200, { status: "completed", url: row.presentation_url });
    if (row.status === "failed") return json(200, { status: "failed" });
    if (!apiKey || !row.gamma_generation_id) return json(200, { status: "processing" });
    try {
      const check = await checkGammaStatus(apiKey, row.gamma_generation_id);
      if (check.failed) {
        await upsertRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "failed" });
        return json(200, { status: "failed" });
      }
      if (check.done && check.url) {
        await upsertRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "completed", presentation_url: check.url });
        return json(200, { status: "completed", url: check.url });
      }
      return json(200, { status: "processing" });
    } catch (e) {
      console.error("gamma status check failed (treated as still-processing)", e);
      return json(200, { status: "processing" });
    }
  }

  if (body.action === "enqueue") {
    if (!apiKey) return json(503, { error: "Presentation generation isn't enabled yet." });
    const existing = await getRow(supabaseUrl, serviceKey, hash);
    if (existing) return json(200, { status: existing.status, url: existing.presentation_url ?? undefined }); // dedupe

    const recap = body.recap;
    if (!recap || typeof recap !== "object") return json(400, { error: "Invalid recap." });

    try {
      const inputText = buildInputText(recap as RecapForPrompt);
      const generationId = await submitGammaGeneration(apiKey, inputText);
      await upsertRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "processing", gamma_generation_id: generationId });
      return json(200, { status: "processing" });
    } catch (e) {
      console.error("gamma enqueue failed", e);
      await upsertRow(supabaseUrl, serviceKey, { recap_hash: hash, status: "failed" });
      return json(502, { error: "Couldn't start the presentation." });
    }
  }

  return json(400, { error: "action must be 'enqueue' or 'status'." });
});
