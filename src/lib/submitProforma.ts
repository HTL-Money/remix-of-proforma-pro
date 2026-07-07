import type { Calc, ModelState } from "@/lib/proforma";

// Direct HTTP call to the Supabase Edge Function — no SDK dependency needed.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const backendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export interface SubmitResult {
  id: string;
  emailed: boolean;
  emailError?: string;
}

export async function submitProforma(payload: {
  state: ModelState;
  results: Calc;
  loEmail?: string;
  chartPng?: string | null;
}): Promise<SubmitResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Backend is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.");
  }
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/submit-proforma`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof json.error === "string" ? json.error : `Submission failed (HTTP ${res.status})`);
  }
  return json as SubmitResult;
}
