import { RetrParseResult } from "@/lib/retrParser";
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
 * Future RETR API integration point. Once API access is available this becomes
 * a call to a Supabase Edge Function that holds the RETR credentials, fetches
 * the LO's report by NMLS, stores it (same shape as saveRetrReport), and
 * returns it. Until then it always reports "nothing found" so the UI falls
 * back to the shared report store / manual PDF upload.
 */
export const fetchRetrFromApi = async (_nmls: string): Promise<StoredRetrReport | null> => {
  return null;
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

/** API first (once it exists), then the shared report store. */
export const lookupRetrReport = async (nmls: string): Promise<StoredRetrReport | null> => {
  return (await fetchRetrFromApi(nmls)) ?? (await getRetrReport(nmls));
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
