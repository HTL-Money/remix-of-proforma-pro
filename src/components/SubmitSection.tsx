import { useState } from "react";
import { CheckCircle2, Circle, Loader2, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { Calc, ModelState, fmtUSD } from "@/lib/proforma";
import { backendConfigured, submitProforma } from "@/lib/submitProforma";

const LAST_SUBMIT_KEY = "htl_lo_proforma_last_submit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Requirement {
  label: string;
  ok: boolean;
}

export const SubmitSection = ({
  state,
  calc,
  getChartSnapshot,
}: {
  state: ModelState;
  calc: Calc;
  getChartSnapshot: () => Promise<string | null>;
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [lastSubmit, setLastSubmit] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_SUBMIT_KEY); } catch { return null; }
  });

  const emailProvided = state.loEmail.trim().length > 0;
  const emailValid = !emailProvided || EMAIL_RE.test(state.loEmail.trim());

  const requirements: Requirement[] = [
    { label: "Loan officer name", ok: state.recruitName.trim().length > 0 },
    { label: "Annual funded volume", ok: state.annualVolume > 0 },
    { label: "Annual funded file count", ok: state.annualFiles > 0 },
    { label: "HTL LO split", ok: state.loSplit > 0 },
    { label: "Current platform BPS (for the comparison)", ok: state.currentSplit != null },
    ...(emailProvided ? [{ label: "Valid email address", ok: emailValid }] : []),
  ];
  const allOk = requirements.every(r => r.ok);

  const submit = async () => {
    if (!allOk || submitting) return;
    setSubmitting(true);
    try {
      const chartPng = await getChartSnapshot();
      const result = await submitProforma({
        state,
        results: calc,
        loEmail: emailProvided ? state.loEmail.trim() : undefined,
        chartPng,
      });
      const now = new Date().toISOString();
      try { localStorage.setItem(LAST_SUBMIT_KEY, now); } catch {}
      setLastSubmit(now);
      if (result.emailed) {
        toast({
          title: "Pro forma submitted",
          description: emailProvided
            ? `Results sent to our recruiting team and to ${state.loEmail.trim()}.`
            : "Results sent to our recruiting team.",
        });
      } else {
        toast({
          title: "Submitted — email pending",
          description: result.emailError
            ? `Saved, but the email could not be sent: ${result.emailError}`
            : "Saved, but the confirmation email could not be sent.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Submission failed",
        description: err instanceof Error ? err.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="premium-card p-6 md:p-8 border-t-4 border-t-accent">
      <div className="flex flex-col lg:flex-row lg:items-center gap-6 lg:gap-10">
        <div className="flex-1">
          <h2 className="section-header !mb-1 !border-0 !pb-0">
            <Send className="h-5 w-5" /> Submit Your Pro Forma
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Sends your numbers and the comparison visual to our recruiting team
            {state.loEmail.trim() ? " — and a copy to your inbox" : ""}.
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {requirements.map(r => (
              <li key={r.label} className={`flex items-center gap-2 text-sm ${r.ok ? "text-foreground" : "text-muted-foreground"}`}>
                {r.ok
                  ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  : <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />}
                {r.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col items-stretch lg:items-end gap-2 lg:min-w-[280px]">
          {allOk && state.currentSplit != null && (
            <p className="text-sm text-muted-foreground lg:text-right">
              Sending: <span className={`font-semibold tabular-nums ${(calc.diffAnnual ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>
                {(calc.diffAnnual ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffAnnual ?? 0)}/yr
              </span> {(calc.diffAnnual ?? 0) >= 0 ? "gain" : "difference"} at Hometown Lending
            </p>
          )}
          <Button
            size="lg"
            disabled={!allOk || submitting || !backendConfigured}
            onClick={submit}
            className="h-12 px-8 text-base gold-accent text-accent-foreground hover:opacity-90 shadow-gold"
          >
            {submitting
              ? <><Loader2 className="h-5 w-5 mr-2 animate-spin" /> Submitting…</>
              : <><Mail className="h-5 w-5 mr-2" /> Submit Pro Forma</>}
          </Button>
          {!backendConfigured && (
            <p className="text-xs text-warning lg:text-right max-w-[280px]">
              Backend not configured — set <code>VITE_SUPABASE_URL</code> and{" "}
              <code>VITE_SUPABASE_ANON_KEY</code> (see .env.example).
            </p>
          )}
          {lastSubmit && (
            <p className="text-xs text-muted-foreground lg:text-right">
              Last submitted {new Date(lastSubmit).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </section>
  );
};
