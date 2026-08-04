// The wall a temp-password account hits before it can use anything.
//
// The rollout handed one shared password to the whole team by email. Asking
// people to change it was not enough: the ask sat in the sidebar, so the shared
// credential — which also reached an address outside our domain — stayed valid
// for anyone who never got around to it. This makes replacing it the price of
// entry rather than a suggestion.
//
// Rendered instead of the routes, not on top of them: an overlay is a styling
// detail that a determined user can inspect their way past, and the pages behind
// it would still be fetching data in the meantime.
//
// Policy rules come from src/lib/password.ts, the same source ResetPassword and
// ChangePasswordDialog use, so all three accept and reject identically.
import { useMemo, useState } from "react";
import { Check, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { PASSWORD_RULES, passwordErrorMessage, validatePassword } from "@/lib/password";

export const ForcePasswordSetup = () => {
  const { user, completePasswordSetup, signOut } = useAuth();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the password change succeeded but clearing the flag did not. The
  // distinction matters: the old password is already gone, so telling this
  // person "something went wrong" would have them typing a password that no
  // longer exists.
  const [changedButStuck, setChangedButStuck] = useState(false);

  const check = useMemo(() => validatePassword(pw), [pw]);
  const matches = pw.length > 0 && pw === confirm;
  const canSubmit = check.valid && matches && !busy;

  const submit = async () => {
    setError(null);
    if (!check.valid) { setError("Your password doesn't meet all the requirements below."); return; }
    if (!matches) { setError("The two passwords don't match."); return; }
    setBusy(true);
    try {
      await completePasswordSetup(pw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("FLAG_NOT_CLEARED")) {
        setChangedButStuck(true);
        setError(null);
      } else {
        setError(passwordErrorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  // Retry path for the narrow case above: the password is already set, so this
  // only needs to land the flag clear. Re-submitting the same value is safe.
  const retryClear = async () => {
    setBusy(true);
    try {
      await completePasswordSetup(pw);
      setChangedButStuck(false);
    } catch {
      // Still failing — the message on screen already says what to do.
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

        {changedButStuck ? (
          <div className="text-center space-y-3">
            <h1 className="font-display font-bold text-xl" style={{ color: "hsl(var(--success))" }}>
              Your password was changed
            </h1>
            <p className="text-sm text-primary-foreground/75">
              The new password is saved — use it from now on. We just couldn't finish
              the last step. Try again, or sign out and back in.
            </p>
            <Button onClick={retryClear} disabled={busy} className="w-full gold-accent text-accent-foreground hover:opacity-90">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Try again
            </Button>
            <button type="button" onClick={signOut} className="text-xs text-primary-foreground/70 underline underline-offset-2">
              Sign out
            </button>
          </div>
        ) : (
          <>
            <div className="text-center space-y-1">
              <h1 className="font-display font-bold text-xl">Set your password</h1>
              <p className="text-sm text-primary-foreground/70">
                You're signed in with the temporary password from your welcome email.
                Choose your own to continue — it's shared with the team until you do.
              </p>
              {user?.email && (
                <p className="text-xs text-primary-foreground/55 pt-1">{user.email}</p>
              )}
            </div>
            <form className="space-y-4 text-left" onSubmit={e => { e.preventDefault(); if (canSubmit) submit(); }}>
              <div className="space-y-1.5">
                <Label htmlFor="force-password" className="text-xs text-primary-foreground/80">New password</Label>
                <Input
                  id="force-password"
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
                <Label htmlFor="force-confirm" className="text-xs text-primary-foreground/80">Confirm new password</Label>
                <Input
                  id="force-confirm"
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
                {busy ? "Saving…" : "Save and continue"}
              </Button>
            </form>
            <div className="text-center">
              <button type="button" onClick={signOut} className="text-xs text-primary-foreground/60 underline underline-offset-2 hover:text-primary-foreground">
                Sign out instead
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
