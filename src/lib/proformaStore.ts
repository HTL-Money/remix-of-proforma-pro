import { ModelState, calculate, defaultState } from "@/lib/proforma";
import { requireSupabase } from "@/lib/supabaseClient";

const TABLE = "proformas";

export interface ProformaSummary {
  id: string;
  name: string;
  updated_at: string;
}

/** Merge stored JSON with defaults so older saves stay compatible with newer
 *  state shapes. Exported for tests — the legacy-key stripping below is the
 *  one place an old blob could silently resurrect a retired input. */
export const hydrate = (data: unknown): ModelState => {
  const def = defaultState();
  const parsed = { ...((data ?? {}) as Partial<ModelState> & { loSplit?: number; holdbackPct?: number }) };
  // Retired inputs that may linger in old blobs. The split is now DERIVED from
  // volume inside calculate(); left in place, a stored manual value would ride
  // the spread below and shadow the derived one.
  delete parsed.loSplit;
  delete parsed.holdbackPct;
  return { ...def, ...parsed, buckets: parsed.buckets ?? def.buckets, employees: parsed.employees ?? def.employees };
};

export const listProformas = async (): Promise<ProformaSummary[]> => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, name, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
};

// Every save keeps a permanent copy in proforma_snapshots (append-only
// history). A snapshot failure never blocks the save itself.
const snapshot = async (proformaId: string, name: string, state: ModelState): Promise<void> => {
  try {
    const supabase = requireSupabase();
    const { error } = await supabase
      .from("proforma_snapshots")
      .insert({ proforma_id: proformaId, name, data: state });
    if (error) console.warn("Snapshot not stored:", error.message);
  } catch (e) {
    console.warn("Snapshot not stored:", e);
  }
};

/**
 * Economics promoted out of the `data` blob into real columns so the team can
 * monitor them (see 20260728000000_proforma_economics.sql). Derived here from
 * calculate() rather than passed in, so the stored metric can never drift from
 * the rendered one. `data` is still the source of truth — these are a
 * queryable projection of it.
 */
const economicsColumns = (state: ModelState) => {
  const calc = calculate(state);
  return {
    nmls: state.nmls || null,
    annual_volume: state.annualVolume,
    annual_files: state.annualFiles || null,
    lo_split: calc.loSplitPct,
    employee_count: state.employees.length,
    payroll_overhead: calc.brokerPaidSalaries + calc.brokerPaidBonuses,
    derived_holdback_pct: calc.requiredHoldbackPct,
    final_lo_net: calc.finalLoNetComp,
  };
};

export const saveProforma = async (name: string, state: ModelState): Promise<string> => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ name, data: state, ...economicsColumns(state) })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await snapshot(data.id, name, state);
  return data.id;
};

// Anonymous submission: writes a `source: 'public'` row and nothing else —
// no `.select()` round-trip, since granting anon any select (even scoped to
// `source = 'public'`) would let anyone with the anon key list every prior
// public submission via a direct REST call. No snapshot either; snapshots
// are team save-history, not meaningful for a one-shot anonymous send.
export const submitPublicProforma = async (name: string, state: ModelState, recruitEmail?: string): Promise<void> => {
  const supabase = requireSupabase();
  const { error } = await supabase.from(TABLE).insert({
    name,
    data: state,
    source: "public",
    // The address the recap is about to be sent to — the recruit's own email
    // on the self-serve flow. Recorded so /submissions works as a CRM.
    recruit_email: recruitEmail?.trim() || null,
    ...economicsColumns(state),
  });
  if (error) throw new Error(error.message);
};

export const updateProforma = async (id: string, name: string, state: ModelState): Promise<void> => {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from(TABLE)
    .update({ name, data: state, updated_at: new Date().toISOString(), ...economicsColumns(state) })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await snapshot(id, name, state);
};

export const loadProforma = async (id: string): Promise<{ name: string; state: ModelState }> => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select("name, data")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return { name: data.name, state: hydrate(data.data) };
};

export const deleteProforma = async (id: string): Promise<void> => {
  const supabase = requireSupabase();
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
};
