import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { signInErrorMessage } from "@/lib/password";

export const LoginGate = () => {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) {
      toast({ title: "Enter your email and password" });
      return;
    }
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      toast({ title: "Sign-in failed", description: signInErrorMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen hero-bg text-primary-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center space-y-8 py-16">
        {/* The real brand artwork (public/htl-logo.png) — navy/gray on white,
            so it keeps the white tile against the navy hero. */}
        <div className="mx-auto rounded-lg bg-white flex items-center justify-center shadow-soft p-3 w-28 h-28 sm:w-36 sm:h-36">
          <img
            src="/htl-logo.png"
            alt="Hometown Lending"
            className="h-full w-full object-contain"
            onError={e => {
              // Hide the tile rather than show a broken-image icon, but never
              // silently: a missing logo shipped unnoticed once.
              console.error("HTL logo failed to load: /htl-logo.png");
              (e.currentTarget.closest("div") as HTMLElement).style.display = "none";
            }}
          />
        </div>
        <div className="space-y-1">
          <h1 className="font-display font-bold tracking-tight text-3xl" style={{ color: "hsl(var(--success))" }}>Hometown Lending</h1>
          <p className="font-display font-semibold text-primary-foreground text-lg">LO Pro Forma</p>
          <p className="text-sm text-primary-foreground/70">Sign in to continue.</p>
        </div>
        <form className="space-y-3 text-left" onSubmit={e => { e.preventDefault(); submit(); }}>
          <div className="space-y-1">
            <Label className="text-xs text-primary-foreground/80">Email</Label>
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@hometownlend.com"
              disabled={busy}
              className="bg-white text-foreground"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-primary-foreground/80">Password</Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
              className="bg-white text-foreground"
            />
          </div>
          <Button type="submit" disabled={busy} className="w-full gold-accent text-accent-foreground hover:opacity-90 h-11">
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <LogIn className="h-4 w-4 mr-2" />}
            {busy ? "Signing in…" : "Sign In"}
          </Button>
        </form>
        <p className="text-xs text-primary-foreground/60">
          Accounts are managed by your administrator in the Supabase dashboard.
        </p>
      </div>
    </div>
  );
};
