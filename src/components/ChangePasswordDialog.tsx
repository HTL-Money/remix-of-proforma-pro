// "Change password" for a signed-in user. Shows the policy requirements live,
// validates client-side against the same rules Supabase enforces, and turns
// server-side weak/leaked-password rejections into readable messages.
import { useMemo, useState } from "react";
import { Check, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { PASSWORD_RULES, passwordErrorMessage, validatePassword } from "@/lib/password";

export const ChangePasswordDialog = () => {
  const { updatePassword } = useAuth();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => validatePassword(pw), [pw]);
  const matches = pw.length > 0 && pw === confirm;
  const canSubmit = check.valid && matches && !busy;

  const reset = () => { setPw(""); setConfirm(""); setError(null); };

  const submit = async () => {
    setError(null);
    if (!check.valid) { setError("Your password doesn't meet all the requirements below."); return; }
    if (!matches) { setError("The two passwords don't match."); return; }
    setBusy(true);
    try {
      await updatePassword(pw);
      toast({ title: "Password updated", description: "Your new password is active." });
      reset();
      setOpen(false);
    } catch (e) {
      // Leaked/weak rejections surface here — show them inline, keep the dialog open.
      setError(passwordErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start text-white/65 hover:text-white hover:bg-white/5">
          <KeyRound className="h-4 w-4 mr-2" /> Change password
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
        </DialogHeader>
        <form className="space-y-4 py-1" onSubmit={e => { e.preventDefault(); if (canSubmit) submit(); }}>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={e => { setPw(e.target.value); setError(null); }}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => { setConfirm(e.target.value); setError(null); }}
              disabled={busy}
            />
            {confirm.length > 0 && !matches && (
              <p className="text-xs text-destructive">The two passwords don't match.</p>
            )}
          </div>

          <ul className="space-y-1 rounded-md bg-secondary/40 p-3">
            {PASSWORD_RULES.map(rule => {
              const met = rule.test(pw);
              return (
                <li key={rule.id} className={`flex items-center gap-2 text-xs ${met ? "text-success" : "text-muted-foreground"}`}>
                  {met ? <Check className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                  {rule.label}
                </li>
              );
            })}
          </ul>

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { reset(); setOpen(false); }}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit} className="gold-accent text-accent-foreground hover:opacity-90">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <KeyRound className="h-4 w-4 mr-1" />}
              {busy ? "Updating…" : "Update password"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
