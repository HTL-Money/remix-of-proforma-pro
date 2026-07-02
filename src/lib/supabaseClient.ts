import { createClient } from "@supabase/supabase-js";

// Filled by hand post-deploy. Until then, the app runs fully offline
// (localStorage only, zero network) — the placeholder guard below must
// never let a build crash or a network call fire against these strings.
const SUPABASE_URL = "__SUPABASE_URL__";
const SUPABASE_PUBLISHABLE_KEY = "__SUPABASE_PUBLISHABLE_KEY__";

export const supabaseEnabled = !SUPABASE_URL.startsWith("__");

export const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  : null;

let sessionPromise: Promise<void> | null = null;
let warnedOnce = false;

const warnOnce = (err: unknown) => {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn("[supabase] ensureSession failed; continuing offline.", err);
};

// Memoized: the anonymous sign-in only ever needs to happen once per page
// load. Never throws — auth failures degrade to "app behaves as if
// Supabase were disabled," never to a broken UI.
export const ensureSession = (): Promise<void> => {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!supabase) return;
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          await supabase.auth.signInAnonymously();
        }
      } catch (err) {
        warnOnce(err);
      }
    })();
  }
  return sessionPromise;
};
