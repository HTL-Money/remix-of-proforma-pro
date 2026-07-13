// Recruiting pipeline: stages, transitions, and the pure aggregation helpers
// the dashboard renders from. Server writes go through setStage so every
// change also lands in the append-only stage_events history.
import { requireSupabase } from "@/lib/supabaseClient";
import { Target } from "@/lib/targetStore";

export type StageKey = "target" | "contacted" | "proforma_sent" | "meeting" | "offer" | "signed" | "lost";

export interface Stage {
  key: StageKey;
  label: string;
}

/** Active funnel order. "lost" sits outside the funnel (any stage can go there). */
export const STAGES: Stage[] = [
  { key: "target", label: "Target" },
  { key: "contacted", label: "Contacted" },
  { key: "proforma_sent", label: "Pro Forma Sent" },
  { key: "meeting", label: "Meeting" },
  { key: "offer", label: "Offer" },
  { key: "signed", label: "Signed" },
];

export const LOST: Stage = { key: "lost", label: "Lost" };
export const ALL_STAGES: Stage[] = [...STAGES, LOST];

export const stageLabel = (key: string): string =>
  ALL_STAGES.find(s => s.key === key)?.label ?? key;

/** Index in the active funnel; -1 for "lost" or unknown. */
export const stageIndex = (key: string): number => STAGES.findIndex(s => s.key === key);

/**
 * Light automation may only push a card FORWARD through the funnel — never
 * backwards, never out of signed/lost. Manual moves don't use this check.
 */
export const canAutoAdvance = (from: string, to: StageKey): boolean => {
  const f = stageIndex(from);
  const t = stageIndex(to);
  if (from === "lost" || from === "signed") return false;
  if (f === -1 || t === -1) return false;
  return t > f;
};

export interface TargetWithStage extends Target {
  stage: StageKey;
  stageUpdatedAt: string | null;
}

export const listPipeline = async (): Promise<TargetWithStage[]> => {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from("target_los")
    .select("nmls, name, city, state, annual_volume, annual_files, source, updated_at, stage, stage_updated_at")
    .order("annual_volume", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    nmls: String(r.nmls),
    name: (r.name as string) ?? null,
    city: (r.city as string) ?? null,
    state: (r.state as string) ?? null,
    annualVolume: Number(r.annual_volume) || 0,
    annualFiles: Number(r.annual_files) || 0,
    source: String(r.source ?? "csv"),
    updatedAt: String(r.updated_at ?? ""),
    stage: (r.stage as StageKey) ?? "target",
    stageUpdatedAt: (r.stage_updated_at as string) ?? null,
  }));
};

/** Move a recruit to a stage and record the change in stage_events. */
export const setStage = async (nmls: string, to: StageKey, from?: string): Promise<void> => {
  const sb = requireSupabase();
  const { error } = await sb
    .from("target_los")
    .update({ stage: to, stage_updated_at: new Date().toISOString() })
    .eq("nmls", nmls);
  if (error) throw new Error(error.message);
  // History is best-effort — a missed event never blocks the move itself.
  try {
    await sb.from("stage_events").insert({ nmls, from_stage: from ?? null, to_stage: to });
  } catch (e) {
    console.warn("stage_events insert failed:", e);
  }
};

/**
 * Called after a recap email sends: advance the matching recruit to
 * "Pro Forma Sent" if they haven't reached it yet. Never throws — the email
 * already went out; pipeline bookkeeping must not surface an error for it.
 */
export const autoAdvanceOnRecap = async (nmls: string): Promise<void> => {
  if (!nmls.trim()) return;
  try {
    const sb = requireSupabase();
    const { data, error } = await sb.from("target_los").select("stage").eq("nmls", nmls.trim()).maybeSingle();
    if (error || !data) return;
    if (canAutoAdvance(String(data.stage ?? "target"), "proforma_sent")) {
      await setStage(nmls.trim(), "proforma_sent", String(data.stage));
    }
  } catch (e) {
    console.warn("Pipeline auto-advance skipped:", e);
  }
};

// ---- Pure aggregation for the dashboard (unit-tested) ----------------------

export interface PipelineStats {
  /** Sum of annual volume for recruits still in play (not signed, not lost). */
  pipelineVolume: number;
  /** Recruits in active stages (not signed, not lost). */
  activeCount: number;
  signedCount: number;
  /** Annual volume signed. */
  signedVolume: number;
  lostCount: number;
  /** signed / (signed + lost + active), 0 when empty. */
  conversionRate: number;
}

export const pipelineStats = (rows: Pick<TargetWithStage, "stage" | "annualVolume">[]): PipelineStats => {
  let pipelineVolume = 0, activeCount = 0, signedCount = 0, signedVolume = 0, lostCount = 0;
  for (const r of rows) {
    if (r.stage === "signed") { signedCount++; signedVolume += r.annualVolume; }
    else if (r.stage === "lost") lostCount++;
    else { activeCount++; pipelineVolume += r.annualVolume; }
  }
  const total = activeCount + signedCount + lostCount;
  return {
    pipelineVolume,
    activeCount,
    signedCount,
    signedVolume,
    lostCount,
    conversionRate: total === 0 ? 0 : signedCount / total,
  };
};

export const groupByStage = <T extends { stage: StageKey }>(rows: T[]): Record<StageKey, T[]> => {
  const groups = Object.fromEntries(ALL_STAGES.map(s => [s.key, []])) as Record<StageKey, T[]>;
  for (const r of rows) (groups[r.stage] ?? groups.target).push(r);
  return groups;
};

// ---- Activity feed ----------------------------------------------------------

export interface ActivityItem {
  kind: "stage" | "email" | "save" | "target";
  at: string; // ISO timestamp
  text: string;
}

/** Merge heterogeneous events into one feed, newest first. Pure. */
export const mergeActivity = (items: ActivityItem[], limit = 15): ActivityItem[] =>
  [...items]
    .filter(i => i.at && !Number.isNaN(Date.parse(i.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);

export const loadActivity = async (): Promise<ActivityItem[]> => {
  const sb = requireSupabase();
  const [events, emails, saves] = await Promise.all([
    sb.from("stage_events").select("nmls, from_stage, to_stage, created_at").order("created_at", { ascending: false }).limit(15),
    sb.from("recap_emails").select("sent_to, payload, created_at").order("created_at", { ascending: false }).limit(15),
    sb.from("proforma_snapshots").select("name, created_at").order("created_at", { ascending: false }).limit(15),
  ]);
  const items: ActivityItem[] = [];
  for (const e of events.data ?? []) {
    items.push({
      kind: "stage",
      at: String(e.created_at),
      text: `NMLS ${e.nmls} moved ${e.from_stage ? `${stageLabel(String(e.from_stage))} → ` : ""}${stageLabel(String(e.to_stage))}`,
    });
  }
  for (const e of emails.data ?? []) {
    const name = (e.payload as { savedName?: string } | null)?.savedName;
    items.push({ kind: "email", at: String(e.created_at), text: `Recap emailed to ${e.sent_to}${name ? ` (“${name}”)` : ""}` });
  }
  for (const s of saves.data ?? []) {
    items.push({ kind: "save", at: String(s.created_at), text: `Pro forma saved: “${s.name}”` });
  }
  return mergeActivity(items);
};
