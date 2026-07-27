import { RetrParseResult } from "@/lib/retrText";
import { annualizeLoStats, fetchLoStats, RetrDateRange, RETR_DEFAULT_RANGE } from "@/lib/retrApi";
import { requireSupabase, supabase } from "@/lib/supabaseClient";

const TABLE = "retr_reports";
const BUCKET = "retr-reports";

export interface StoredRetrReport {
  nmls: string;
  loName: string | null;
  parsed: RetrParseResult;
  pdfUrl: string | null;
  updatedAt: string;
}

export const normalizeNmls = (raw: string): string => raw.replace(/\D/g, "");

/**
 * Live RETR pull via the retr-proxy Edge Function (which holds the RETR
 * credentials server-side). Returns null for every "no live data" case —
 * credentials not yet set, NMLS unknown, network trouble — so the UI falls
 * back to the shared report store / manual PDF upload.
 */
export const fetchRetrFromApi = async (
  nmls: string,
  dateRange: RetrDateRange = RETR_DEFAULT_RANGE,
): Promise<StoredRetrReport | null> => {
  const live = await fetchLoStats(nmls, dateRange);
  if (!live) return null;
  const parsed = annualizeLoStats(live.dto, dateRange);
  return {
    nmls,
    loName: parsed.recruitName,
    parsed,
    pdfUrl: null,
    updatedAt: live.fetchedAt ?? new Date().toISOString(),
  };
};

export const getRetrReport = async (nmls: string): Promise<StoredRetrReport | null> => {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from(TABLE)
    .select("nmls, lo_name, parsed, pdf_path, updated_at")
    .eq("nmls", nmls)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const pdfUrl = data.pdf_path
    ? sb.storage.from(BUCKET).getPublicUrl(data.pdf_path).data.publicUrl
    : null;
  return {
    nmls: data.nmls,
    loName: data.lo_name,
    parsed: data.parsed as RetrParseResult,
    pdfUrl,
    updatedAt: data.updated_at,
  };
};

/**
 * Live API first, then the shared report store. `sharedStore: false` skips
 * the store — anonymous visitors must, since retr_reports RLS is
 * authenticated-only and the query would just fail.
 */
export const lookupRetrReport = async (
  nmls: string,
  opts?: { sharedStore?: boolean; dateRange?: RetrDateRange },
): Promise<StoredRetrReport | null> => {
  const live = await fetchRetrFromApi(nmls, opts?.dateRange ?? RETR_DEFAULT_RANGE);
  if (live) return live;
  if (opts?.sharedStore === false) return null;
  return getRetrReport(nmls);
};

export const saveRetrReport = async (nmls: string, parsed: RetrParseResult, pdf: File): Promise<string | null> => {
  const sb = requireSupabase();
  const pdfPath = `${nmls}.pdf`;
  const { error: uploadError } = await sb.storage
    .from(BUCKET)
    .upload(pdfPath, pdf, { upsert: true, contentType: "application/pdf" });
  if (uploadError) throw new Error(uploadError.message);
  const { error } = await sb.from(TABLE).upsert({
    nmls,
    lo_name: parsed.recruitName,
    parsed,
    pdf_path: pdfPath,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return sb.storage.from(BUCKET).getPublicUrl(pdfPath).data.publicUrl;
};

export const isCloudConfigured = (): boolean => supabase !== null;
