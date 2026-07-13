import { useState } from "react";
import { ArrowRight, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { lookupRetrReport, normalizeNmls, isCloudConfigured, StoredRetrReport } from "@/lib/retrReportStore";
import htlLogo from "@/assets/htl-logo.png.asset.json";

interface NmlsGateProps {
  onEnter: (result: { nmls: string; report: StoredRetrReport | null }) => void;
  onSkip: () => void;
}

export const NmlsGate = ({ onEnter, onSkip }: NmlsGateProps) => {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const nmls = normalizeNmls(value);
    if (!nmls) {
      toast({ title: "Enter an NMLS number", description: "Digits only — e.g. 123456. Or start without one below." });
      return;
    }
    if (!isCloudConfigured()) {
      toast({ title: "Working locally", description: "Supabase isn't configured, so no RETR data could be pulled for this NMLS." });
      onEnter({ nmls, report: null });
      return;
    }
    setBusy(true);
    try {
      const report = await lookupRetrReport(nmls);
      onEnter({ nmls, report });
    } catch (e) {
      toast({ title: "Lookup failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      onEnter({ nmls, report: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen hero-bg text-primary-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-lg text-center space-y-8 py-16">
        <div className="mx-auto rounded-lg bg-white flex items-center justify-center shadow-soft p-3" style={{ width: "160px", height: "160px" }}>
          <img src={htlLogo.url} alt="Hometown Lending" className="h-full w-full object-contain" />
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
              className="pl-9 h-12 text-lg tabular-nums bg-white text-foreground"
            />
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
