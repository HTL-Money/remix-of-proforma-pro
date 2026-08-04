import { createContext, useContext, useEffect, useState } from "react";
import { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

interface AuthValue {
  /** True when Supabase is configured, so sign-in is enforced. */
  authRequired: boolean;
  loading: boolean;
  user: User | null;
  /** null while the server check is in flight, then the confirmed answer.
   *  Chrome treats null as "not admin" (nothing flashes); route guards treat
   *  it as "wait" (no premature redirect). Without Supabase (local dev, no
   *  auth) everything is admin, matching authRequired=false. */
  isAdmin: boolean | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  authRequired: false,
  loading: false,
  user: null,
  isAdmin: true,
  signIn: async () => {},
  signOut: async () => {},
  updatePassword: async () => {},
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(supabase !== null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(supabase === null ? true : null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Role is decided server-side (RLS calls the same is_admin() function), so
  // this rpc is display-only: it picks which chrome to draw, never what data
  // is reachable.
  //
  // Three things this has to get right, each of which bit once:
  //   - Never answer `false` while the session is still resolving. On a cold
  //     load the effect runs with user still null, and a definite `false` makes
  //     RequireAdmin redirect a real admin to /links before the session lands.
  //     `loading` is the difference between "not an admin" and "don't know yet".
  //   - Key on the user's id, not the user object. onAuthStateChange hands over
  //     a fresh object on every hourly token refresh, which would re-enter this
  //     effect and blank out an admin's page mid-work.
  //   - Treat an rpc failure as unknown, not as demotion. A transient network
  //     error must not quietly turn an admin into an LO; retry, then leave it
  //     unresolved rather than answer wrongly.
  useEffect(() => {
    if (!supabase) { setIsAdmin(true); return; }
    if (loading) { setIsAdmin(null); return; }
    if (!user) { setIsAdmin(false); return; }

    let cancelled = false;
    setIsAdmin(null);
    (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        const { data, error } = await supabase.rpc("is_admin");
        if (cancelled) return;
        if (!error) { setIsAdmin(data === true); return; }
        console.warn(`is_admin check failed (attempt ${attempt + 1}/3):`, error.message);
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
      // Still unresolved: admin chrome stays hidden and admin routes keep
      // waiting, but nobody is misclassified. RLS is the real boundary either
      // way, so the worst case is a reload.
    })();
    return () => { cancelled = true; };
  }, [loading, user?.id]);

  const signIn = async (email: string, password: string) => {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  // Throws the raw AuthError (not a re-wrapped Error) so callers can inspect
  // its code/message — weak-password and leaked-password rejections included.
  const updatePassword = async (newPassword: string) => {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ authRequired: supabase !== null, loading, user, isAdmin, signIn, signOut, updatePassword }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
