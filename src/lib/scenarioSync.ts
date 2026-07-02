import type { Calc, ModelState } from "@/lib/proforma";
import { ensureSession, supabase } from "@/lib/supabaseClient";

const SCENARIO_ID_KEY = "htl_scenario_id_v1";
const REF_CODE_KEY = "htl_ref_code_v1";

// Mirrors the DB check constraint `referrers_code_format`:
//   code ~ '^[a-z0-9][a-z0-9_-]{0,31}$'
const REF_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Trim/lowercase and validate against the same shape as the DB's
 * `referrers_code_format` check constraint. Returns null for anything
 * that wouldn't pass the DB constraint (empty, too long, bad leading
 * char, disallowed characters).
 */
export const sanitizeRefCode = (raw: string | null | undefined): string | null => {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!REF_CODE_RE.test(trimmed)) return null;
  return trimmed;
};

/**
 * Stable per-device scenario id, persisted in localStorage. Created once,
 * then reused for the lifetime of the browser storage.
 */
export const getOrCreateScenarioId = (): string => {
  const existing = localStorage.getItem(SCENARIO_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(SCENARIO_ID_KEY, id);
  return id;
};

export const getStoredRefCode = (): string | null => {
  return localStorage.getItem(REF_CODE_KEY);
};

/**
 * First-touch wins: the originally-referring LO keeps attribution for the
 * lifetime of this device's storage. A later ?ref= must never overwrite it.
 */
export const storeRefCode = (code: string): void => {
  if (localStorage.getItem(REF_CODE_KEY)) return;
  localStorage.setItem(REF_CODE_KEY, code);
};

export interface ScenarioSnapshot {
  finalLoNetComp: number;
  monthlyLoNet: number;
  diffAnnual: number | null;
  diffMonthly: number | null;
  annualVolume: number;
  annualFiles: number;
  avgLoanAmount: number;
  loSplit: number;
  currentSplit: number | null;
  holdbackPct: number;
  corrActive: boolean;
  retrImported: boolean;
}

export const buildSnapshot = (
  state: ModelState,
  calc: Calc,
  retrImported: boolean
): ScenarioSnapshot => ({
  finalLoNetComp: calc.finalLoNetComp,
  monthlyLoNet: calc.monthlyLoNet,
  diffAnnual: calc.diffAnnual,
  diffMonthly: calc.diffMonthly,
  annualVolume: state.annualVolume,
  annualFiles: state.annualFiles,
  avgLoanAmount: state.avgLoanAmount,
  loSplit: state.loSplit,
  currentSplit: state.currentSplit,
  holdbackPct: state.holdbackPct,
  corrActive: state.buckets.some(b => b.channel === "Correspondent" && b.active),
  retrImported,
});

/**
 * Reads ?ref= from the URL, sanitizes it, and (if no code is already
 * stored) validates + stores it. Never throws — attribution capture is
 * best-effort and must never block or break the app.
 */
export const captureRefFromUrl = async (): Promise<string | null> => {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("ref");
    const sanitized = sanitizeRefCode(raw);

    const already = getStoredRefCode();
    if (already) return already;
    if (!sanitized) return null;

    if (!supabase) {
      // Better to capture unvalidated attribution than lose it entirely.
      storeRefCode(sanitized);
      return sanitized;
    }

    const { data } = await supabase
      .from("referrers")
      .select("code")
      .eq("code", sanitized)
      .eq("active", true)
      .maybeSingle();

    if (data?.code) {
      storeRefCode(sanitized);
      return sanitized;
    }
    return null;
  } catch (err) {
    console.warn("[scenarioSync] captureRefFromUrl failed", err);
    return null;
  }
};

/**
 * Fire-and-forget upsert of the current scenario. No-op when Supabase is
 * disabled. Never throws, never surfaces to the UI — this is telemetry,
 * not a feature the user depends on.
 */
export const syncScenario = async (
  state: ModelState,
  calc: Calc,
  opts: { retrImported: boolean }
): Promise<void> => {
  if (!supabase) return;
  try {
    await ensureSession();
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) return;

    await supabase.from("scenarios").upsert({
      id: getOrCreateScenarioId(),
      user_id: userId,
      recruit_name: state.recruitName || null,
      state,
      snapshot: buildSnapshot(state, calc, opts.retrImported),
      referrer_code: getStoredRefCode(),
      // Omitted entirely when false so an upsert never flips a
      // previously-true DB value back to false.
      ...(opts.retrImported ? { retr_imported: true } : {}),
    });
  } catch (err) {
    console.warn("[scenarioSync] syncScenario failed", err);
  }
};

/**
 * Fire-and-forget engagement event log. No-op when Supabase is disabled.
 * Never throws, never surfaces to the UI.
 */
export const logEvent = (type: string, payload?: Record<string, unknown>): void => {
  if (!supabase) return;
  (async () => {
    try {
      await ensureSession();
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) return;

      await supabase.from("events").insert({
        scenario_id: getOrCreateScenarioId(),
        user_id: userId,
        type,
        payload: payload ?? null,
      });
    } catch (err) {
      console.warn("[scenarioSync] logEvent failed", err);
    }
  })();
};
