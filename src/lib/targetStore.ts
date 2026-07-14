import { requireSupabase } from "@/lib/supabaseClient";
import { TargetRow } from "@/lib/csv";

const TABLE = "target_los";

export interface Target {
  nmls: string;
  name: string | null;
  city: string | null;
  state: string | null;
  annualVolume: number;
  annualFiles: number;
  source: string;
  updatedAt: string;
}

const fromRow = (r: any): Target => ({
  nmls: r.nmls,
  name: r.name,
  city: r.city,
  state: r.state,
  annualVolume: Number(r.annual_volume) || 0,
  annualFiles: Number(r.annual_files) || 0,
  source: r.source,
  updatedAt: r.updated_at,
});

export const listTargets = async (): Promise<Target[]> => {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select("nmls, name, city, state, annual_volume, annual_files, source, updated_at")
    .order("annual_volume", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
};

export const importTargets = async (rows: TargetRow[]): Promise<number> => {
  const sb = requireSupabase();
  const now = new Date().toISOString();
  const payload = rows.map(r => ({
    nmls: r.nmls,
    name: r.name,
    city: r.city,
    state: r.state,
    annual_volume: r.annualVolume,
    annual_files: r.annualFiles,
    source: "csv",
    updated_at: now,
  }));
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await sb.from(TABLE).upsert(payload.slice(i, i + CHUNK), { onConflict: "nmls" });
    if (error) throw new Error(error.message);
  }
  return payload.length;
};

export const deleteTarget = async (nmls: string): Promise<void> => {
  const sb = requireSupabase();
  const { error } = await sb.from(TABLE).delete().eq("nmls", nmls);
  if (error) throw new Error(error.message);
};

/** NMLS numbers that already have a stored RETR report, for the "on file" badge. */
export const listNmlsWithReports = async (): Promise<Set<string>> => {
  const sb = requireSupabase();
  const { data, error } = await sb.from("retr_reports").select("nmls");
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r: any) => r.nmls as string));
};
