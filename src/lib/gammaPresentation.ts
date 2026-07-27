// Client wrapper around the gamma-proxy Edge Function: kicks off a
// per-recruit Gamma presentation at send time, and polls its status from the
// hosted recap page. Both directions are best-effort — a Gamma hiccup must
// never block the email/save it rides alongside, or break the recap page
// (which always has the numbers to fall back to).
import { requireSupabase } from "@/lib/supabaseClient";
import type { RecapPayload } from "../../supabase/functions/send-recap/template";

export type PresentationStatus = "unknown" | "processing" | "completed" | "failed";

export interface PresentationStatusResult {
  status: PresentationStatus;
  url?: string;
}

/** Fire-and-forget: starts (or, for a hash already in flight, just confirms)
 *  generation. Never throws. `recap` supplies the numbers the presentation
 *  is built from — RecapPayload carries no employee data, so nothing
 *  sensitive crosses this call. */
export const enqueueRecapPresentation = async (hash: string, recap: RecapPayload): Promise<void> => {
  try {
    const supabase = requireSupabase();
    await supabase.functions.invoke("gamma-proxy", { body: { action: "enqueue", hash, recap } });
  } catch (e) {
    console.warn("Presentation enqueue skipped:", e);
  }
};

/** Polls current status. Resolves to {status:"unknown"} on any failure so the
 *  caller just keeps showing its fallback rather than surfacing an error. */
export const pollRecapPresentationStatus = async (hash: string): Promise<PresentationStatusResult> => {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase.functions.invoke("gamma-proxy", { body: { action: "status", hash } });
    if (error || !data) return { status: "unknown" };
    const status = (data as { status?: string }).status;
    const url = (data as { url?: string }).url;
    const valid: PresentationStatus[] = ["unknown", "processing", "completed", "failed"];
    return { status: valid.includes(status as PresentationStatus) ? (status as PresentationStatus) : "unknown", url };
  } catch {
    return { status: "unknown" };
  }
};
