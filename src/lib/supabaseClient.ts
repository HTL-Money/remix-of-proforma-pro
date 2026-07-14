import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const isConfigured = Boolean(url && anonKey && !url.includes("your-project") && !anonKey.includes("your-anon-key"));

if (!isConfigured) {
  console.warn(
    "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env to enable cloud save/load."
  );
}

export const supabase: SupabaseClient | null = isConfigured ? createClient(url, anonKey) : null;

/** Returns the client or throws a user-facing error for toast display. */
export const requireSupabase = (): SupabaseClient => {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.");
  }
  return supabase;
};
