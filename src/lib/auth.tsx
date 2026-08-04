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
  // is reachable. Re-resolved whenever the signed-in user changes.
  useEffect(() => {
    if (!supabase || !user) { setIsAdmin(supabase === null ? true : false); return; }
    let cancelled = false;
    setIsAdmin(null);
    supabase.rpc("is_admin").then(({ data, error }) => {
      if (!cancelled) setIsAdmin(!error && data === true);
    });
    return () => { cancelled = true; };
  }, [user]);

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
