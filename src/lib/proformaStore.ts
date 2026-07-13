import { ModelState, defaultState } from "@/lib/proforma";
import { requireSupabase } from "@/lib/supabaseClient";

const TABLE = "proformas";

export interface ProformaSummary {
  id: string;
  name: string;
  updated_at: string;
}

/** Merge stored JSON with defaults so older saves stay compatible with newer state shapes. */
const hydrate = (data: unknown): ModelState => {
  const def = defaultState();
  const parsed = (data ?? {}) as Partial<ModelState>;
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

export const saveProforma = async (name: string, state: ModelState): Promise<string> => {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ name, data: state })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
};

export const updateProforma = async (id: string, name: string, state: ModelState): Promise<void> => {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from(TABLE)
    .update({ name, data: state, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
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
