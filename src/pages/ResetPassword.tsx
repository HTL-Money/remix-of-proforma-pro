// Where a password-recovery link lands. Supabase puts the recovery token in the
// URL fragment, its client picks it up and emits PASSWORD_RECOVERY, and from
// that point the visitor holds a real (recovery-scoped) session — so setting the
// new password is the ordinary updateUser call.
//
// Rendered OUTSIDE the AppShell, like the public recap page: someone who cannot
// get in should not be looking at team chrome. Reuses the same policy rules and
// error mapping as ChangePasswordDialog so both paths accept and reject
// identically — a second copy of the policy would eventually disagree with the
// server's.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabaseClient";
import { PASSWORD_RULES, passwordErrorMessage, validatePassword } from "@/lib/password";

type Stage = "waiting" | "ready" | "done" | "invalid";

const ResetPassword = () => {
  const [stage, setStage] = useState<Stage>("waiting");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => validatePassword(pw), [pw]);
  const matches = pw.length > 0 && pw === confirm;
  const canSubmit = check.valid && matches && !busy;

  useEffect(() => {
    if (!supabase) { setStage("invalid"); return; }
    // An existing session already counts: Supabase may have consumed the token
    // before this component mounted, in which case no event is coming.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setStage(s => (s === "waiting" ? "ready" : s));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setStage(s => (s === "done" ? s : "ready"));
    });
    // A link that is expired, already used, or hand-typed produces no session at
    // all. Say so rather than showing a form that cannot work.
    const timer = setTimeout(() => setStage(s => (s === "waiting" ? "invalid" : s)), 6000);
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  const submit = async () => {
    if (!supabase) return;
    setError(null);
    if (!check.valid) { setError("Your password doesn't meet all the requirements below."); return; }
    if (!matches) { setError("The two passwords don't match."); return; }
    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password: pw });
      if (err) throw err;
      setStage("done");
    } catch (e) {
      setError(passwordErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen hero-bg text-primary-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 py-16">
        <div className="mx-auto rounded-lg bg-white flex items-center justify-center shadow-soft p-3 w-24 h-24">
          <img src="/htl-logo.png" alt="Hometown Lending" className="h-full w-full object-contain" />
        </div>

        {stage === "waiting" && (
          <p className="text-center text-sm text-primary-foreground/70">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Checking your link…
          </p>
        )}

        {stage === "invalid" && (
          <div className="text-center space-y-3">
            <h1 className="font-display font-bold text-xl">This link has expired</h1>
            <p className="text-sm text-primary-foreground/70">
              Reset links are single-use and time-limited. Request a fresh one from the sign-in page.
            </p>
            <Button asChild className="w-full gold-accent text-accent-foreground hover:opacity-90">
              <Link to="/links">Back to sign in</Link>
            </Button>
          </div>
        )}

        {stage === "done" && (
          <div className="text-center space-y-3">
            <h1 className="font-display font-bold text-xl" style={{ color: "hsl(var(--success))" }}>Password updated</h1>
            <p className="text-sm text-primary-foreground/70">You're signed in — go ahead and get to work.</p>
            <Button asChild className="w-full gold-accent text-accent-foreground hover:opacity-90">
              <Link to="/links">Open Recruit Links</Link>
            </Button>
          </div>
        )}

        {stage === "ready" && (
          <>
            <div className="text-center space-y-1">
              <h1 className="font-display font-bold text-xl">Choose a new password</h1>
              <p className="text-sm text-primary-foreground/70">This replaces the one you were given.</p>
            </div>
            <form className="space-y-4 text-left" onSubmit={e => { e.preventDefault(); if (canSubmit) submit(); }}>
              <div className="space-y-1.5">
                <Label htmlFor="reset-password" className="text-xs text-primary-foreground/80">New password</Label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={pw}
                  onChange={e => { setPw(e.target.value); setError(null); }}
                  disabled={busy}
                  className="bg-white text-foreground"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reset-confirm" className="text-xs text-primary-foreground/80">Confirm new password</Label>
                <Input
                  id="reset-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(null); }}
                  disabled={busy}
                  className="bg-white text-foreground"
                />
                {confirm.length > 0 && !matches && (
                  <p className="text-xs text-destructive">The two passwords don't match.</p>
                )}
              </div>

              <ul className="space-y-1 rounded-md bg-white/10 p-3">
                {PASSWORD_RULES.map(rule => {
                  const met = rule.test(pw);
                  return (
                    <li key={rule.id} className={`flex items-center gap-2 text-xs ${met ? "text-white" : "text-primary-foreground/60"}`}>
                      {met ? <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "hsl(var(--success))" }} /> : <X className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                      {rule.label}
                    </li>
                  );
                })}
              </ul>

              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

              <Button type="submit" disabled={!canSubmit} className="w-full gold-accent text-accent-foreground hover:opacity-90 h-11">
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
                {busy ? "Saving…" : "Save new password"}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
