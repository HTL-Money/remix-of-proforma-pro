import { useState } from "react";
import { ArrowRight, Loader2, Percent, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { bpsToSplit } from "@/lib/bps";
import { lookupRetrReport, normalizeNmls, isCloudConfigured, StoredRetrReport } from "@/lib/retrReportStore";

interface NmlsGateProps {
  onEnter: (result: { nmls: string; report: StoredRetrReport | null; currentSplit: number | null }) => void;
  onSkip: () => void;
}

export const NmlsGate = ({ onEnter, onSkip }: NmlsGateProps) => {
  const [value, setValue] = useState("");
  // Current comp in BPS, collected up front so the comparison is populated
  // the moment the pro forma renders — otherwise the recruit lands on a
  // "enter your LO BPS above" placeholder where the payoff should be.
  // Optional: not everyone knows their split, and an HTL-only projection
  // still works without it.
  const [bps, setBps] = useState("");
  const [busy, setBusy] = useState(false);
  const { authRequired, user } = useAuth();
  // Anonymous visitors get the live RETR API only — the shared report store
  // is authenticated-only under RLS and the query would just fail.
  const isTeamMember = !authRequired || !!user;

  const submit = async () => {
    const nmls = normalizeNmls(value);
    const currentSplit = bpsToSplit(bps);
    if (!nmls) {
      toast({ title: "Enter an NMLS number", description: "Digits only — e.g. 123456. Or start without one below." });
      return;
    }
    if (!isCloudConfigured()) {
      toast({ title: "Working locally", description: "Supabase isn't configured, so no RETR data could be pulled for this NMLS." });
      onEnter({ nmls, report: null, currentSplit });
      return;
    }
    setBusy(true);
    try {
      const report = await lookupRetrReport(nmls, { sharedStore: isTeamMember });
      onEnter({ nmls, report, currentSplit });
    } catch (e) {
      toast({ title: "Lookup failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      onEnter({ nmls, report: null, currentSplit });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen hero-bg text-primary-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-lg text-center space-y-8 py-16">
        {/* The real brand artwork (public/htl-logo.png) — navy/gray on white,
            so it keeps the white tile against the navy hero. */}
        <div className="mx-auto rounded-lg bg-white flex items-center justify-center shadow-soft p-3 w-32 h-32 sm:w-44 sm:h-44">
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
        <div className="space-y-2">
          <h1 className="font-display font-bold tracking-tight" style={{ color: "hsl(var(--success))", fontSize: "clamp(2rem, 5vw, 3.25rem)", lineHeight: 1.05 }}>
            Hometown Lending
          </h1>
          <p className="font-display font-semibold text-primary-foreground text-xl md:text-2xl">LO Pro Forma</p>
          <p className="text-sm text-primary-foreground/75">Enter the loan officer's NMLS number to pull in their production.</p>
        </div>
        <form
          className="space-y-3"
          onSubmit={e => { e.preventDefault(); submit(); }}
        >
          <div className="relative max-w-sm mx-auto">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              inputMode="numeric"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="NMLS #"
              disabled={busy}
              aria-label="NMLS number"
              className="pl-9 h-12 text-lg tabular-nums bg-white text-foreground"
            />
          </div>
          <div className="max-w-sm mx-auto space-y-1">
            <div className="relative">
              <Percent className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                inputMode="numeric"
                value={bps}
                onChange={e => setBps(e.target.value)}
                placeholder="Current comp in BPS — e.g. 200 (optional)"
                disabled={busy}
                aria-label="Current comp in BPS (optional)"
                className="pl-9 h-12 tabular-nums bg-white text-foreground"
              />
            </div>
            <p className="text-xs text-primary-foreground/60 text-left">
              3-digit BPS (200 = 2.00%) — powers your side-by-side comparison. Skip it if you're not sure.
            </p>
          </div>
          <Button type="submit" disabled={busy} className="gold-accent text-accent-foreground hover:opacity-90 h-11 px-8 text-base">
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {busy ? "Looking up…" : "Continue"} {!busy && <ArrowRight className="h-4 w-4 ml-1" />}
          </Button>
        </form>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="text-sm text-primary-foreground/60 hover:text-primary-foreground underline underline-offset-4"
        >
          Start without an NMLS
        </button>
      </div>
    </div>
  );
};
