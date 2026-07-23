// Client wrapper around the higgsfield-proxy Edge Function: kicks off a
// per-recruit cinematic video at send time, and polls its status from the
// hosted recap page. Both directions are best-effort — a Higgsfield hiccup
// must never block the email/save it rides alongside, or break the recap
// page (which always has the vault GIF to fall back to).
import { requireSupabase } from "@/lib/supabaseClient";

export type VideoStatus = "unknown" | "processing" | "completed" | "failed";

export interface VideoStatusResult {
  status: VideoStatus;
  url?: string;
}

/** Fire-and-forget: starts (or, for a hash already in flight, just confirms)
 *  generation. Never throws. */
export const enqueueRecapVideo = async (hash: string, chartPngBase64: string): Promise<void> => {
  try {
    const supabase = requireSupabase();
    await supabase.functions.invoke("higgsfield-proxy", { body: { action: "enqueue", hash, chartPng: chartPngBase64 } });
  } catch (e) {
    console.warn("Cinematic video enqueue skipped:", e);
  }
};

/** Polls current status. Resolves to {status:"unknown"} on any failure so the
 *  caller just keeps showing its fallback rather than surfacing an error. */
export const pollRecapVideoStatus = async (hash: string): Promise<VideoStatusResult> => {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase.functions.invoke("higgsfield-proxy", { body: { action: "status", hash } });
    if (error || !data) return { status: "unknown" };
    const status = (data as { status?: string }).status;
    const url = (data as { url?: string }).url;
    const valid: VideoStatus[] = ["unknown", "processing", "completed", "failed"];
    return { status: valid.includes(status as VideoStatus) ? (status as VideoStatus) : "unknown", url };
  } catch {
    return { status: "unknown" };
  }
};
