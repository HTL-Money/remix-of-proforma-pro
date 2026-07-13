import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, RotateCcw, Trash2, TrendingUp, AlertTriangle, Wallet, Users, Calculator, Minus, ListChecks, LogOut } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import {
  ModelState, defaultState, calculate, calculateBrokerOnly, fmtUSD, fmtPct,
  BROKER_CAP, CORR_MIN, CORR_MAX, Bucket, Employee, ChannelKey, Role,
  ROLE_OPTIONS, PROCESSOR_DEFAULTS, PaySource, MIX_PRESETS,
  LOA_EXTRA_BONUS, LOAN_PARTNER_EXTRA_BONUS, QM_FEE, NONQM_FEE, CORR_FEE,
} from "@/lib/proforma";
import { Chips } from "@/components/Chips";
import htlLogo from "@/assets/htl-logo.png.asset.json";
import { CurrencyInput } from "@/components/CurrencyInput";
import { RetrImport } from "@/components/RetrImport";
import { CloudSave } from "@/components/CloudSave";
import { NmlsGate } from "@/components/NmlsGate";
import { RetrParseResult } from "@/lib/retrParser";
import {
  StoredRetrReport, lookupRetrReport, saveRetrReport, normalizeNmls, isCloudConfigured,
} from "@/lib/retrReportStore";
import { useAuth } from "@/lib/auth";

const STORAGE_KEY = "htl_lo_proforma_v6";
const GATE_KEY = "htl_nmls_gate_v1";

// One-tap quick picks — recruiting targets are $10M+ producers.
const VOLUME_CHIPS = [12, 18, 24, 36, 48, 75].map(m => ({ label: `$${m}M`, value: m * 1_000_000 }));
const BPS_CHIPS = [100, 125, 150, 200, 250, 275].map(b => ({ label: String(b), value: b }));
const MIX_KEYS = ["fha", "va", "conv", "nonqm"] as const;
// Stop scroll-wheel / trackpad from silently changing focused number inputs.
const blurOnWheel = (e: React.WheelEvent<HTMLInputElement>) => e.currentTarget.blur();

// Map a parsed RETR report onto the model — shared by the NMLS gate,
// the "Pull RETR data" button, and the PDF drop zone.
const applyRetrResult = (s: ModelState, r: RetrParseResult): ModelState => {
  const total = r.annualFiles;
  const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
  return {
    ...s,
    recruitName: r.recruitName ?? s.recruitName,
    nmls: r.nmls ?? s.nmls,
    annualVolume: r.annualVolume,
    annualFiles: r.annualFiles,
    avgLoanAmount: r.avgLoanAmount || s.avgLoanAmount,
    avgLoanOverride: false,
    loanTypeMix: {
      fha: pct(r.byLoanType.fha),
      va: pct(r.byLoanType.va),
      conv: pct(r.byLoanType.conv),
      nonqm: pct(r.byLoanType.nonqm),
    },
  };
};

const loadState = (): ModelState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const def = defaultState();
      return { ...def, ...parsed, buckets: parsed.buckets ?? def.buckets, employees: parsed.employees ?? def.employees };
    }
  } catch {}
  return defaultState();
};

// ---- Small UI primitives ----
const Stat = ({ label, value, accent, mono = true }: { label: string; value: string; accent?: "primary" | "gold" | "success" | "warning" | "destructive"; mono?: boolean }) => {
  const color =
    accent === "gold" ? "text-accent" :
    accent === "success" ? "text-success" :
    accent === "warning" ? "text-warning" :
    accent === "destructive" ? "text-destructive" :
    "text-primary";
  return (
    <div className="flex flex-col gap-1">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${color} ${mono ? "tabular-nums" : ""}`}>{value}</span>
    </div>
  );
};

const Section: React.FC<{ icon?: React.ReactNode; title: string; children: React.ReactNode; right?: React.ReactNode; defaultOpen?: boolean; compact?: boolean; id?: string }> = ({ icon, title, children, right, defaultOpen = true, compact = false, id }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className={`premium-card scroll-mt-4 ${compact ? "px-4 py-2 md:px-5 md:py-2.5" : "p-6 md:p-8"}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className={`flex flex-wrap items-center justify-between gap-3 ${compact ? (open ? "mb-3" : "mb-0") : "mb-6"}`}>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-6 w-6 rounded-full border-accent/40 text-accent hover:bg-accent hover:text-accent-foreground"
                aria-label={open ? "Collapse section" : "Expand section"}
              >
                {open ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              </Button>
            </CollapsibleTrigger>
            <h2 className={`section-header !mb-0 !border-0 !pb-0 ${compact ? "!text-base" : ""}`}>{icon}{title}</h2>
          </div>
          {right}
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
};

const Warn = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
    <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
    <span>{children}</span>
  </div>
);

const emptyEmployee = (role: Role = "Processor"): Omit<Employee, "id"> => {
  if (role === "Processor") {
    return { name: "", role, ...PROCESSOR_DEFAULTS };
  }
  const extra = role === "Loan Officer Assistant" ? LOA_EXTRA_BONUS
              : role === "Loan Partner" ? LOAN_PARTNER_EXTRA_BONUS
              : 0;
  return {
    name: "",
    role,
    salary: 0,
    salarySource: "Broker",
    qmBonus: 0,
    nonQmBonus: 0,
    bonusSource: "Broker",
    extraBonus: extra,
  };
};


const AddEmployeeDialog = ({ onAdd }: { onAdd: (emp: Omit<Employee, "id">) => void }) => {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>("Processor");
  const [name, setName] = useState("");
  const [salary, setSalary] = useState<number>(PROCESSOR_DEFAULTS.salary);
  const [salarySource, setSalarySource] = useState<PaySource>("HTL");
  const [bonusSource, setBonusSource] = useState<PaySource>("HTL");
  const [qmBonus, setQmBonus] = useState<number>(PROCESSOR_DEFAULTS.qmBonus);
  const [nonQmBonus, setNonQmBonus] = useState<number>(PROCESSOR_DEFAULTS.nonQmBonus);
  const [extraBonus, setExtraBonus] = useState<number>(0);

  // Auto-fill defaults when role changes
  useEffect(() => {
    if (role === "Processor") {
      setSalary(PROCESSOR_DEFAULTS.salary);
      setSalarySource("HTL");
      setQmBonus(PROCESSOR_DEFAULTS.qmBonus);
      setNonQmBonus(PROCESSOR_DEFAULTS.nonQmBonus);
      setBonusSource("HTL");
      setExtraBonus(0);
    } else {
      setSalary(0);
      setSalarySource("Broker");
      setQmBonus(0);
      setNonQmBonus(0);
      setBonusSource("Broker");
      setExtraBonus(role === "Loan Officer Assistant" ? LOA_EXTRA_BONUS
                    : role === "Loan Partner" ? LOAN_PARTNER_EXTRA_BONUS : 0);
    }
  }, [role]);

  const reset = () => { setRole("Processor"); setName(""); };
  const submit = () => {
    onAdd({ name, role, salary, salarySource, qmBonus, nonQmBonus, bonusSource, extraBonus });
    reset();
    setOpen(false);
  };

  const isProcessor = role === "Processor";
  const isSupport = role === "Loan Officer Assistant" || role === "Loan Partner";

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gold-accent text-accent-foreground hover:opacity-90">
          <Plus className="h-4 w-4 mr-1" /> Add Employee
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Employee</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Role / Title</Label>
              <Select value={role} onValueChange={v => setRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {isProcessor && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Annual Salary (HTL-paid)</Label>
                  <CurrencyInput value={salary} onChange={setSalary} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">QM Per-File Bonus (HTL-paid)</Label>
                  <CurrencyInput value={qmBonus} onChange={setQmBonus} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Non-QM Per-File Bonus (HTL-paid)</Label>
                  <CurrencyInput value={nonQmBonus} onChange={setNonQmBonus} />
                </div>
              </>
            )}
            {isSupport && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Annual Salary</Label>
                  <CurrencyInput value={salary} onChange={setSalary} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Salary Paid By</Label>
                  <Select value={salarySource} onValueChange={v => setSalarySource(v as PaySource)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Broker">Broker</SelectItem>
                      <SelectItem value="HTL">Hometown Lending</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">Broker-Paid Per-File Bonus</Label>
                  <CurrencyInput value={extraBonus} onChange={setExtraBonus} />
                </div>
              </>
            )}
          </div>
          {isProcessor && (
            <p className="text-xs text-muted-foreground">
              Processor salaries and per-file bonuses are paid by Hometown Lending.
            </p>
          )}
          {isSupport && (
            <p className="text-xs text-muted-foreground">
              The broker must pay this per-file bonus for each {role}. It is deducted from the LO's compensation.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} className="gold-accent text-accent-foreground hover:opacity-90">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---- Main page ----
const Index = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkNmls = normalizeNmls(searchParams.get("nmls") ?? "");
  const { authRequired, user, signOut } = useAuth();
  const [state, setState] = useState<ModelState>(() => loadState());
  const [gated, setGated] = useState(() => !sessionStorage.getItem(GATE_KEY) && !deepLinkNmls);
  const [retrPdfUrl, setRetrPdfUrl] = useState<string | null>(null);
  const [pullingRetr, setPullingRetr] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // Deep link from the Targets page: ?nmls=... auto-loads that LO, skipping the gate.
  useEffect(() => {
    if (!deepLinkNmls) return;
    sessionStorage.setItem(GATE_KEY, "1");
    setGated(false);
    (async () => {
      if (isCloudConfigured()) {
        try {
          const report = await lookupRetrReport(deepLinkNmls);
          if (report) applyStoredReport(deepLinkNmls, report);
          else { setState({ ...defaultState(), nmls: deepLinkNmls }); toast({ title: "No RETR report on file", description: `Nothing stored yet for NMLS ${deepLinkNmls}. Drop the PDF to import and share it.` }); }
        } catch (e) {
          setState({ ...defaultState(), nmls: deepLinkNmls });
          toast({ title: "Lookup failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
        }
      } else {
        setState({ ...defaultState(), nmls: deepLinkNmls });
      }
      setSearchParams({}, { replace: true });
    })();
  }, [deepLinkNmls]); // eslint-disable-line

  // Keep avg loan in sync
  useEffect(() => {
    if (!state.avgLoanOverride && state.annualFiles > 0) {
      const v = state.annualVolume / state.annualFiles;
      if (Math.abs(v - state.avgLoanAmount) > 0.5) {
        setState(s => ({ ...s, avgLoanAmount: v }));
      }
    }
  }, [state.annualVolume, state.annualFiles, state.avgLoanOverride]); // eslint-disable-line

  const calc = useMemo(() => calculate(state), [state]);
  const calcBrokerOnly = useMemo(() => calculateBrokerOnly(state), [state]);
  const corrUplift = calc.finalLoNetComp - calcBrokerOnly.finalLoNetComp;
  const corrActive = state.buckets.some(b => b.channel === "Correspondent" && b.active);

  // Volume edits keep the average loan steady and rescale the file count,
  // so one number (volume) is usually all a user has to touch.
  const setVolume = (v: number) => setState(s => {
    const avg = s.avgLoanAmount > 0 ? s.avgLoanAmount : 400_000;
    const files = v > 0 ? Math.max(1, Math.round(v / avg)) : 0;
    return { ...s, annualVolume: v, annualFiles: files };
  });

  const activeMixPreset = MIX_PRESETS.find(p =>
    MIX_KEYS.every(k => Math.abs(p.mix[k] - state.loanTypeMix[k]) < 0.51)
  )?.key ?? null;
  const setCorrEnabled = (on: boolean) => setState(s => ({
    ...s,
    buckets: s.buckets.map(b => b.channel === "Correspondent" ? { ...b, active: on } : b),
  }));

  const updateBucket = (key: ChannelKey, patch: Partial<Bucket>) => {
    setState(s => ({
      ...s,
      buckets: s.buckets.map(b => {
        if (b.key !== key) return b;
        const next = { ...b, ...patch };
        if (patch.compPct !== undefined) {
          if (b.channel === "Broker" && patch.compPct > BROKER_CAP) {
            toast({ title: "Broker comp capped", description: `Broker comp is capped at ${BROKER_CAP}%.` });
            next.compPct = BROKER_CAP;
          }
          if (b.channel === "Correspondent") {
            if (patch.compPct < CORR_MIN) next.compPct = CORR_MIN;
            if (patch.compPct > CORR_MAX) next.compPct = CORR_MAX;
          }
        }
        return next;
      }),
    }));
  };


  const updateEmployee = (id: string, patch: Partial<Employee>) => {
    setState(s => ({ ...s, employees: s.employees.map(e => e.id === id ? { ...e, ...patch } : e) }));
  };
  const removeEmployee = (id: string) => {
    setState(s => ({ ...s, employees: s.employees.filter(e => e.id !== id) }));
  };

  const reset = () => {
    setState(defaultState());
    setRetrPdfUrl(null);
    sessionStorage.removeItem(GATE_KEY);
    setGated(true);
    toast({ title: "Model reset", description: "All inputs restored to defaults." });
  };

  const applyStoredReport = (nmls: string, report: StoredRetrReport) => {
    setState(applyRetrResult({ ...defaultState(), nmls }, report.parsed));
    setRetrPdfUrl(report.pdfUrl);
    toast({
      title: "RETR data pulled",
      description: `${report.loName ?? "Loan Officer"} (NMLS ${nmls}) — ${report.parsed.annualFiles} files, ${fmtUSD(report.parsed.annualVolume, { compact: true })}`,
    });
  };

  const handleGateEnter = ({ nmls, report }: { nmls: string; report: StoredRetrReport | null }) => {
    sessionStorage.setItem(GATE_KEY, "1");
    setGated(false);
    if (normalizeNmls(state.nmls) === nmls && state.annualVolume > 0) {
      // Same LO as the in-progress draft — resume it rather than clobbering edits.
      toast({ title: "Resumed", description: `Continuing your in-progress pro forma for NMLS ${nmls}.` });
      return;
    }
    if (report) {
      applyStoredReport(nmls, report);
    } else {
      setState({ ...defaultState(), nmls });
      // When unconfigured, the gate already toasted "Working locally" — don't replace it (TOAST_LIMIT is 1).
      if (isCloudConfigured()) {
        toast({ title: "No RETR report on file", description: `Drop the RETR PDF for NMLS ${nmls} in the Production section to import and share it.` });
      }
    }
  };

  const handleGateSkip = () => {
    sessionStorage.setItem(GATE_KEY, "1");
    setGated(false);
  };

  const pullRetr = async () => {
    const nmls = normalizeNmls(state.nmls);
    if (!nmls) {
      toast({ title: "Enter an NMLS number first", description: "Add the LO's NMLS next to their name, then pull." });
      return;
    }
    if (!isCloudConfigured()) {
      toast({ title: "Supabase not configured", description: "Add credentials to .env to pull shared RETR data." });
      return;
    }
    setPullingRetr(true);
    try {
      const report = await lookupRetrReport(nmls);
      if (report) applyStoredReport(nmls, report);
      else toast({ title: "No RETR report on file", description: `Nothing stored yet for NMLS ${nmls}. Drop the PDF below to import and share it.` });
    } catch (e) {
      toast({ title: "Lookup failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setPullingRetr(false);
    }
  };

  if (gated) {
    return <NmlsGate onEnter={handleGateEnter} onSkip={handleGateSkip} />;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Hero header */}
      <header className="hero-bg text-primary-foreground border-b border-border/40">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 md:py-10">
          <div className="flex items-start justify-between gap-4 md:gap-6 flex-wrap">
            <div className="flex items-start gap-4 md:gap-6 flex-col sm:flex-row min-w-0">
              <div className="rounded-lg bg-white flex items-center justify-center shadow-soft p-2 md:p-3 shrink-0 w-20 h-20 md:w-48 md:h-48">
                <img
                  src={htlLogo.url}
                  alt="Hometown Lending"
                  className="h-full w-full object-contain"
                  onError={e => { (e.currentTarget.closest("div") as HTMLElement).style.display = "none"; }}
                />
              </div>
              <div className="md:pt-2 min-w-0">
                <h1 className="font-display font-bold leading-none tracking-tight" style={{ color: "hsl(var(--success))", fontSize: "clamp(2rem, 7vw, 6rem)" }}>Hometown Lending</h1>
                <p className="font-display font-semibold mt-2 md:mt-4 text-primary-foreground flex flex-wrap items-baseline gap-x-3 gap-y-1" style={{ lineHeight: 1.1 }}>
                  <span style={{ fontSize: "clamp(1.25rem, 3.5vw, 3rem)" }}>LO Pro Forma:</span>
                  <span className="italic text-primary-foreground/85 font-normal" style={{ fontSize: "clamp(0.95rem, 1.8vw, 1.5rem)" }}>Your Production's True Value</span>
                </p>
              </div>

            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {isCloudConfigured() && (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
                >
                  <Link to="/targets" title="Target loan officers"><ListChecks className="h-4 w-4 mr-1" /> Target LOs</Link>
                </Button>
              )}
              <CloudSave
                state={state}
                onLoad={(loaded) => setState(loaded)}
              />
              {authRequired && user && (
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Sign out"
                  title={`Sign out (${user.email})`}
                  onClick={() => signOut()}
                  className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Reset"
                  title="Reset"
                  className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset all inputs?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This clears everything you've entered and cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={reset}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            </div>
          </div>
        </div>
      </header>


      <main className="max-w-7xl mx-auto px-4 md:px-8 py-8 pb-28 md:pb-8 space-y-8">
        {/* Headline KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="premium-card p-5">
            <Stat label="Annual LO Net Compensation" value={fmtUSD(calc.finalLoNetComp)} accent="gold" />
          </div>
          <div className="premium-card p-5">
            <Stat label="Estimated Monthly LO Net" value={fmtUSD(calc.monthlyLoNet)} accent="primary" />
          </div>
          <div className="premium-card p-5">
            <Stat
              label="Difference vs Current Platform"
              value={`${(calc.diffAnnual ?? 0) >= 0 ? "+" : ""}${fmtUSD(calc.diffAnnual ?? 0)}`}
              accent={(calc.diffAnnual ?? 0) >= 0 ? "success" : "destructive"}
            />
            {calc.diffAnnual != null && (
              <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                {(calc.diffMonthly ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffMonthly ?? 0)} / month
              </p>
            )}
          </div>
        </div>


        {/* Production */}
        <Section icon={<Calculator className="h-5 w-5" />} title="Production" compact>
          <div className="mb-4 space-y-1">
            <RetrImport
              hint={normalizeNmls(state.nmls) && !retrPdfUrl ? `to import & share for NMLS ${normalizeNmls(state.nmls)}` : undefined}
              onImport={(r, file) => {
                const enteredNmls = normalizeNmls(state.nmls);
                if (r.nmls && enteredNmls && r.nmls !== enteredNmls) {
                  toast({ title: "NMLS mismatch", description: `This PDF is for NMLS ${r.nmls}, not ${enteredNmls}. Using ${r.nmls}.`, variant: "destructive" });
                }
                setState(s => applyRetrResult(s, r));
                toast({ title: "RETR imported", description: `${r.recruitName ?? "Loan Officer"} — ${r.annualFiles} files, ${fmtUSD(r.annualVolume, { compact: true })}` });
                const shareNmls = r.nmls ?? enteredNmls;
                if (shareNmls && isCloudConfigured()) {
                  saveRetrReport(shareNmls, r, file)
                    .then(url => {
                      setRetrPdfUrl(url);
                      toast({ title: "Report shared", description: `RETR report for NMLS ${shareNmls} is now on file for the whole team.` });
                    })
                    .catch(e => toast({ title: "Couldn't share report", description: e instanceof Error ? e.message : String(e), variant: "destructive" }));
                }
              }}
            />
            {retrPdfUrl && (
              <a href={retrPdfUrl} target="_blank" rel="noreferrer" className="inline-block text-xs text-accent underline underline-offset-2 hover:opacity-80">
                Download the RETR PDF on file{normalizeNmls(state.nmls) ? ` for NMLS ${normalizeNmls(state.nmls)}` : ""}
              </a>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* The two numbers that drive the answer come first. */}
            <div className="space-y-2 md:col-span-1 lg:col-span-2">
              <Label htmlFor="annual-volume">Annual Funded Volume</Label>
              <CurrencyInput
                id="annual-volume"
                className="max-w-[240px]"
                value={state.annualVolume}
                placeholder="48,000,000"
                onChange={setVolume}
              />
              <Chips aria-label="Volume quick picks" options={VOLUME_CHIPS} value={state.annualVolume} onChange={setVolume} />
              <p className="text-xs text-muted-foreground">Tap a preset or type shorthand like <span className="font-medium text-foreground">48m</span>.</p>
            </div>
            <div className="space-y-2 md:col-span-1 lg:col-span-2">
              <Label htmlFor="current-bps">Current Platform LO Comp (BPS)</Label>
              <Input
                id="current-bps"
                className="max-w-[240px] tabular-nums"
                type="number"
                inputMode="numeric"
                step="1"
                min={0}
                max={275}
                onWheel={blurOnWheel}
                value={state.currentSplit == null ? "" : Math.round(state.currentSplit * 100)}
                placeholder="e.g. 200"
                onChange={e => setState(s => ({ ...s, currentSplit: e.target.value === "" ? null : (+e.target.value || 0) / 100 }))}
              />
              <Chips
                aria-label="BPS quick picks"
                options={BPS_CHIPS}
                value={state.currentSplit == null ? null : Math.round(state.currentSplit * 100)}
                onChange={b => setState(s => ({ ...s, currentSplit: b / 100 }))}
              />
              <p className="text-xs text-muted-foreground">
                3-digit BPS (200 = 2.00%). {state.currentSplit != null && <span className="font-semibold text-accent">= {fmtPct(state.currentSplit, 2)}</span>}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Loan Officer</Label>
              <Input className="max-w-[200px]" value={state.recruitName} onChange={e => setState(s => ({ ...s, recruitName: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>NMLS #</Label>
              <div className="flex gap-2 max-w-[240px]">
                <Input
                  inputMode="numeric"
                  className="tabular-nums"
                  value={state.nmls}
                  onChange={e => setState(s => ({ ...s, nmls: e.target.value }))}
                  placeholder="123456"
                />
                <Button variant="outline" size="sm" className="h-10 shrink-0" onClick={pullRetr} disabled={pullingRetr} title="Pull stored RETR data for this NMLS">
                  {pullingRetr ? "Pulling…" : "Pull RETR"}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Annual Funded File Count</Label>
              <Input
                className="max-w-[200px]"
                type="number"
                inputMode="numeric"
                onWheel={blurOnWheel}
                value={state.annualFiles || ""}
                placeholder="0"
                onChange={e => setState(s => ({ ...s, annualFiles: +e.target.value || 0, avgLoanOverride: false }))}
              />
              <p className="text-xs text-muted-foreground">Auto-syncs when volume changes.</p>
            </div>
            <div className="space-y-2">
              <Label>Average Loan Amount {state.avgLoanOverride && <span className="text-xs text-warning">(manual)</span>}</Label>
              <div className="flex gap-2 max-w-[200px]">
                <CurrencyInput
                  value={Math.round(state.avgLoanAmount)}
                  onChange={v => setState(s => ({ ...s, avgLoanAmount: v, avgLoanOverride: true }))}
                />
                {state.avgLoanOverride && (
                  <Button variant="outline" size="sm" onClick={() => setState(s => ({ ...s, avgLoanOverride: false }))}>Auto</Button>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>HTL LO Split</Label>
              <Chips
                aria-label="HTL LO split"
                options={[90, 85, 80].map(v => ({ label: `${v}%`, value: v }))}
                value={state.loSplit}
                onChange={v => setState(s => ({ ...s, loSplit: v }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Team-Support Holdback</Label>
              <Chips
                aria-label="Team-support holdback"
                options={[0, 10, 20].map(v => ({ label: `${v}%`, value: v }))}
                value={state.holdbackPct}
                onChange={v => setState(s => ({ ...s, holdbackPct: v }))}
              />
            </div>
            <div className="space-y-2 md:col-span-2 lg:col-span-4">
              <Label>Loan Type Mix (Files)</Label>
              <Chips
                aria-label="Loan mix presets"
                options={MIX_PRESETS.map(p => ({ label: p.label, value: p.key }))}
                value={activeMixPreset}
                onChange={key => {
                  const preset = MIX_PRESETS.find(p => p.key === key);
                  if (preset) setState(s => ({ ...s, loanTypeMix: { ...preset.mix } }));
                }}
              />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl pt-1">
                {(["fha","va","conv","nonqm"] as const).map(k => {
                  const labels: Record<typeof k, string> = { fha: "FHA", va: "VA", conv: "Conventional", nonqm: "Non-QM" } as any;
                  const order: Array<"fha"|"va"|"conv"|"nonqm"> = ["fha","va","conv","nonqm"];
                  const total = Math.max(0, Math.round(state.annualFiles || 0));
                  const counts: Record<"fha"|"va"|"conv"|"nonqm", number> = (() => {
                    const c: any = {};
                    let used = 0;
                    order.forEach((key, i) => {
                      if (i === order.length - 1) c[key] = Math.max(0, total - used);
                      else { c[key] = Math.round(total * (state.loanTypeMix[key] / 100)); used += c[key]; }
                    });
                    return c;
                  })();
                  const pct = total > 0 ? (counts[k] / total) * 100 : state.loanTypeMix[k];
                  return (
                    <div key={k} className="space-y-1">
                      <Label className="text-xs">{labels[k]}</Label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step="1"
                        onWheel={blurOnWheel}
                        value={counts[k]}
                        onChange={e => setState(s => {
                          const tot = Math.max(0, Math.round(s.annualFiles || 0));
                          if (tot <= 0) return s;
                          const raw = Math.min(tot, Math.max(0, Math.round(+e.target.value || 0)));
                          const idx = order.indexOf(k);
                          const cur: any = {};
                          let used0 = 0;
                          order.forEach((key, i) => {
                            if (i === order.length - 1) cur[key] = Math.max(0, tot - used0);
                            else { cur[key] = Math.round(tot * (s.loanTypeMix[key] / 100)); used0 += cur[key]; }
                          });
                          const nextCounts: any = { ...cur, [k]: raw };
                          const headSum = order.slice(0, idx).reduce((a, key) => a + nextCounts[key], 0);
                          const trailing = order.slice(idx + 1);
                          const remaining = Math.max(0, tot - headSum - raw);
                          if (trailing.length === 0) {
                            if (headSum + raw > tot && headSum > 0) {
                              const scale = (tot - raw) / headSum;
                              order.slice(0, idx).forEach(key => { nextCounts[key] = Math.max(0, Math.round(nextCounts[key] * scale)); });
                            }
                          } else {
                            const trailSum = trailing.reduce((a, key) => a + cur[key], 0);
                            if (trailSum > 0) {
                              let allocated = 0;
                              trailing.forEach((key, i) => {
                                if (i === trailing.length - 1) nextCounts[key] = Math.max(0, remaining - allocated);
                                else { nextCounts[key] = Math.max(0, Math.round((cur[key] / trailSum) * remaining)); allocated += nextCounts[key]; }
                              });
                            } else {
                              const base = Math.floor(remaining / trailing.length);
                              const rem = remaining - base * trailing.length;
                              trailing.forEach((key, i) => { nextCounts[key] = base + (i === trailing.length - 1 ? rem : 0); });
                            }
                          }
                          const nextMix = {
                            fha: (nextCounts.fha / tot) * 100,
                            va: (nextCounts.va / tot) * 100,
                            conv: (nextCounts.conv / tot) * 100,
                            nonqm: (nextCounts.nonqm / tot) * 100,
                          };
                          return { ...s, loanTypeMix: nextMix };
                        })}
                      />
                      <p className="text-[10px] text-muted-foreground">{pct.toFixed(1)}%</p>
                    </div>
                  );
                })}
              </div>
              {(() => {
                const total = Math.max(0, Math.round(state.annualFiles || 0));
                const order: Array<"fha"|"va"|"conv"|"nonqm"> = ["fha","va","conv","nonqm"];
                let used = 0;
                const counts: any = {};
                order.forEach((key, i) => {
                  if (i === order.length - 1) counts[key] = Math.max(0, total - used);
                  else { counts[key] = Math.round(total * (state.loanTypeMix[key] / 100)); used += counts[key]; }
                });
                const sum = counts.fha + counts.va + counts.conv + counts.nonqm;
                return (
                  <p className={`text-xs ${sum === total ? "text-muted-foreground" : "text-warning"}`}>
                    Files total {sum} of {total} (auto-balances to match Annual Funded File Count). FHA stays Broker (2.75% cap). VA & Conventional route to Correspondent when active; otherwise Broker. Non-QM routes to Correspondent Non-QM when active.
                  </p>
                );
              })()}
            </div>
          </div>
        </Section>

        {/* Team builder — collapsed by default to keep above-the-fold tight */}
        <Section
          icon={<Users className="h-5 w-5" />}
          title="Team & Employee Support"
          defaultOpen={false}
          compact
          right={<AddEmployeeDialog onAdd={(emp) => setState(s => ({ ...s, employees: [...s.employees, { id: crypto.randomUUID(), ...emp }] }))} />}
        >
          <p className="text-sm text-muted-foreground mb-4">
            Processor salaries and per-file bonuses are paid by Hometown Lending. Loan Officer Assistants and Loan Partners are paid by the broker, and their per-file bonus is deducted from the LO's compensation.
          </p>
          {state.employees.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-secondary/30 px-4 py-6 text-sm text-muted-foreground text-center">
              No team members yet. Click <span className="font-medium text-foreground">Add Employee</span> to build out your support team.
            </div>
          )}
          <div className="space-y-3">
            {state.employees.map(e => {
              const isProcessor = e.role === "Processor";
              return (
                <div key={e.id} className="grid grid-cols-1 md:grid-cols-12 gap-3 p-4 rounded-lg border border-border bg-secondary/30">
                  <div className="md:col-span-3 space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input value={e.name} onChange={ev => updateEmployee(e.id, { name: ev.target.value })} placeholder="Name" />
                  </div>
                  <div className="md:col-span-3 space-y-1">
                    <Label className="text-xs">Role / Title</Label>
                    <div className="flex items-center h-10 px-3 rounded-md border border-input bg-muted/40 text-sm">{e.role}</div>
                  </div>
                  {isProcessor ? (
                    <>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Salary (HTL)</Label>
                        <CurrencyInput value={e.salary} onChange={v => updateEmployee(e.id, { salary: v })} />
                      </div>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs">QM/file</Label>
                        <CurrencyInput value={e.qmBonus} onChange={v => updateEmployee(e.id, { qmBonus: v })} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Non-QM/file</Label>
                        <CurrencyInput value={e.nonQmBonus} onChange={v => updateEmployee(e.id, { nonQmBonus: v })} />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Annual Salary</Label>
                        <CurrencyInput value={e.salary} onChange={v => updateEmployee(e.id, { salary: v })} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Salary Paid By</Label>
                        <Select value={e.salarySource} onValueChange={v => updateEmployee(e.id, { salarySource: v as PaySource })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Broker">Broker</SelectItem>
                            <SelectItem value="HTL">Hometown Lending</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs">$/file</Label>
                        <CurrencyInput value={e.extraBonus} onChange={v => updateEmployee(e.id, { extraBonus: v })} />
                      </div>
                    </>
                  )}
                  <div className="md:col-span-1 flex items-end justify-end">
                    <Button variant="ghost" size="icon" onClick={() => removeEmployee(e.id)} className="text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {state.employees.length > 0 && (
            <div className="mt-6">
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Annual Cost Per Employee</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {state.employees.map(e => {
                  const totalFiles = calc.totals.qmFiles + calc.totals.nonQmFiles;
                  const bonusAnnual = e.role === "Processor"
                    ? calc.totals.qmFiles * (e.qmBonus || 0) + calc.totals.nonQmFiles * (e.nonQmBonus || 0)
                    : (e.extraBonus || 0) * totalFiles;
                  const total = (e.salary || 0) + bonusAnnual;
                  return (
                    <div key={e.id} className="premium-card p-4">
                      <p className="text-xs text-muted-foreground">{e.role}</p>
                      <p className="font-semibold text-primary">{e.name || "Unnamed"}</p>
                      <p className="stat-value text-accent mt-2 tabular-nums">{fmtUSD(total)}</p>
                      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                        <div className="flex justify-between"><span>Salary ({e.salarySource})</span><span className="tabular-nums">{fmtUSD(e.salary || 0)}</span></div>
                        <div className="flex justify-between"><span>Per-file bonuses</span><span className="tabular-nums">{fmtUSD(bonusAnnual)}</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Section>


        {/* Comparison Tool */}
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Comparison Tool" id="comparison">
          <div className="mb-6 max-w-xl">
            <Label className="text-xs">Channel Strategy</Label>
            <Chips
              aria-label="Channel strategy"
              className="mt-2"
              options={[
                { label: "Broker Only", value: "broker" },
                { label: "Broker + Correspondent", value: "corr" },
              ]}
              value={corrActive ? "corr" : "broker"}
              onChange={v => setCorrEnabled(v === "corr")}
            />
            {corrActive && (
              <div className="flex flex-wrap gap-2 mt-3">
                {state.buckets.filter(b => b.channel === "Correspondent").map(b => (
                  <label key={b.key} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-2 text-xs cursor-pointer">
                    <Switch checked={b.active} onCheckedChange={v => updateBucket(b.key, { active: v })} />
                    <span className="font-medium">{b.label}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1.5">
              Routes VA / Conventional / Non-QM through Correspondent at {fmtUSD(CORR_FEE)}/file. FHA always stays Broker.
            </p>
          </div>

          {state.currentSplit == null ? (
            <p className="text-sm text-muted-foreground">Enter your <span className="font-medium text-foreground">LO BPS</span> in the Production section above to see a comparison.</p>
          ) : (() => {
            const currentBrokerGross = state.annualVolume * 0.0275;
            const currentLoComp = state.annualVolume * (state.currentSplit / 100);
            const htlBrokerGross = calc.totals.grossRevenue;
            const brokerGrossDelta = htlBrokerGross - currentBrokerGross;
            const loCompDelta = calc.diffAnnual ?? 0;
            const monthlyDelta = calc.diffMonthly ?? 0;
            return (
              <div className="space-y-6">
                {/* Side-by-side platform cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Current Platform */}
                  <div className="premium-card p-6 flex flex-col">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Current Platform</p>
                    <p className="stat-label mt-1">{Math.round(state.currentSplit * 100)} BPS · {fmtPct(state.currentSplit, 2)}</p>
                    <p className="text-3xl font-bold text-foreground tabular-nums mt-3">{fmtUSD(calc.currentPlatformAnnual ?? 0)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{fmtUSD(calc.currentPlatformMonthly ?? 0)} / month</p>
                    <div className="mt-4 space-y-1 text-xs text-muted-foreground border-t border-border pt-3">
                      <div className="flex justify-between"><span>Broker gross (2.75%)</span><span className="tabular-nums">{fmtUSD(currentBrokerGross)}</span></div>
                      <div className="flex justify-between"><span>LO comp ({Math.round(state.currentSplit * 100)} BPS)</span><span className="tabular-nums">{fmtUSD(currentLoComp)}</span></div>
                      {calc.brokerPaidSalaries > 0 && (
                        <div className="flex justify-between text-destructive"><span>Less broker-paid salaries</span><span className="tabular-nums">−{fmtUSD(calc.brokerPaidSalaries)}</span></div>
                      )}
                      {(calc.brokerPaidBonuses + calc.extraBonusTotal) > 0 && (
                        <div className="flex justify-between text-destructive"><span>Less broker-paid per-file bonuses</span><span className="tabular-nums">−{fmtUSD(calc.brokerPaidBonuses + calc.extraBonusTotal)}</span></div>
                      )}
                    </div>
                  </div>

                  {/* Hometown Lending */}
                  {/* Not premium-card: its gradient background would paint over bg-primary and hide the white text. */}
                  <div className="rounded-lg shadow-soft p-6 bg-primary text-primary-foreground flex flex-col">
                    <p className="text-xs uppercase tracking-wider text-accent font-semibold">Hometown Lending</p>
                    <p className="stat-label mt-1 !text-primary-foreground/70">{corrActive ? "Broker + Correspondent" : "Broker Only"}</p>
                    <p className="text-3xl font-bold text-accent tabular-nums mt-3">{fmtUSD(calc.finalLoNetComp)}</p>
                    <p className="text-xs text-primary-foreground/80 mt-1">{fmtUSD(calc.monthlyLoNet)} / month</p>
                    <div className="mt-4 space-y-1 text-xs text-primary-foreground/80 border-t border-primary-foreground/15 pt-3">
                      <div className="flex justify-between"><span>Broker gross</span><span className="tabular-nums">{fmtUSD(htlBrokerGross)}</span></div>
                      <div className="flex justify-between"><span>LO gross split ({state.loSplit}%)</span><span className="tabular-nums">{fmtUSD(calc.totals.loGrossSplit)}</span></div>
                      <div className="flex justify-between text-destructive-foreground/90"><span>Less channel fees</span><span className="tabular-nums">−{fmtUSD(calc.totals.channelFees)}</span></div>
                      {calc.brokerPaidSalaries > 0 && (
                        <div className="flex justify-between text-destructive-foreground/90"><span>Less broker-paid salaries</span><span className="tabular-nums">−{fmtUSD(calc.brokerPaidSalaries)}</span></div>
                      )}
                      {(calc.brokerPaidBonuses + calc.extraBonusTotal) > 0 && (
                        <div className="flex justify-between text-destructive-foreground/90"><span>Less broker-paid per-file bonuses</span><span className="tabular-nums">−{fmtUSD(calc.brokerPaidBonuses + calc.extraBonusTotal)}</span></div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Grandiose delta box */}
                <div
                  className="rounded-xl p-8 md:p-10 border-2 border-accent/40 text-center"
                  style={{ background: "var(--gradient-gold)" }}
                >
                  <p className="text-xs md:text-sm uppercase tracking-[0.2em] text-accent-foreground/90 font-bold">Your Gain at Hometown Lending</p>
                  <p className={`font-display font-bold tabular-nums mt-3 ${loCompDelta >= 0 ? "text-accent-foreground" : "text-destructive"}`} style={{ fontSize: "clamp(2.5rem, 6vw, 4.5rem)", lineHeight: 1 }}>
                    {loCompDelta >= 0 ? "+" : ""}{fmtUSD(loCompDelta)}
                  </p>
                  <p className="text-sm md:text-base text-accent-foreground/90 mt-2 tabular-nums">
                    {monthlyDelta >= 0 ? "+" : ""}{fmtUSD(monthlyDelta)} / month more in your pocket
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6 max-w-2xl mx-auto">
                    <div className="rounded-lg bg-primary/10 border border-accent-foreground/15 p-3 text-left">
                      <p className="text-[10px] uppercase tracking-wider text-accent-foreground/70 font-semibold">Broker Gross Uplift</p>
                      <p className={`text-lg font-bold tabular-nums ${brokerGrossDelta >= 0 ? "text-accent-foreground" : "text-destructive"}`}>
                        {brokerGrossDelta >= 0 ? "+" : ""}{fmtUSD(brokerGrossDelta)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-primary/10 border border-accent-foreground/15 p-3 text-left">
                      <p className="text-[10px] uppercase tracking-wider text-accent-foreground/70 font-semibold">LO Comp Uplift</p>
                      <p className={`text-lg font-bold tabular-nums ${loCompDelta >= 0 ? "text-accent-foreground" : "text-destructive"}`}>
                        {loCompDelta >= 0 ? "+" : ""}{fmtUSD(loCompDelta)}
                      </p>
                    </div>
                  </div>
                  {corrActive && (
                    <div className="mt-4 space-y-1">
                      <p className="text-xs text-accent-foreground/80 italic">Correspondent uplift over HTL Broker-Only: <span className="font-semibold">{corrUplift >= 0 ? "+" : ""}{fmtUSD(corrUplift)}</span></p>
                      <p className="text-xs text-accent-foreground/80 italic">Correspondent uplift over your current broker: <span className="font-semibold">{loCompDelta >= 0 ? "+" : ""}{fmtUSD(loCompDelta)}</span></p>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

        </Section>



        {/* Production buckets */}
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Production Buckets">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-3 pr-3 font-semibold">Bucket</th>
                  <th className="py-3 px-2 font-semibold">Vol %</th>
                  <th className="py-3 px-2 font-semibold">$ Volume</th>
                  <th className="py-3 px-2 font-semibold">Avg Loan</th>
                  <th className="py-3 px-2 font-semibold">Comp %</th>
                  <th className="py-3 px-2 font-semibold">LO Net Pre-Holdback</th>
                  <th className="py-3 px-2 font-semibold">Holdback</th>
                  <th className="py-3 pl-2 font-semibold">Initial LO Cash</th>
                </tr>
              </thead>
              <tbody>
                {state.buckets.filter(b => b.active && b.key !== "broker_nonqm").map(b => {
                  const c = calc.buckets.find(x => x.bucket.key === b.key);
                  const isBroker = b.channel === "Broker";
                  return (
                    <tr key={b.key} className="border-b border-border/60">
                      <td className="py-3 pr-3 align-top">
                        <div className="font-semibold text-primary">{b.label}</div>
                        <div className="text-xs text-muted-foreground">{b.channel} · {b.loanType} · ${b.channel === "Correspondent" ? CORR_FEE : (b.loanType === "QM" ? QM_FEE : NONQM_FEE)}/file</div>
                      </td>
                      <td className="px-2 align-top tabular-nums">{c ? fmtPct(c.volumePct, 1) : "—"}</td>
                      <td className="px-2 align-top tabular-nums">{c ? fmtUSD(c.dollarVolume, { compact: true }) : "—"}</td>
                      <td className="px-2 align-top tabular-nums">{c ? fmtUSD(c.avgLoan) : "—"}</td>
                      <td className="px-2 align-top">
                        <Input
                          className="w-24"
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min={isBroker ? 0 : CORR_MIN}
                          max={isBroker ? BROKER_CAP : CORR_MAX}
                          onWheel={blurOnWheel}
                          value={b.compPct}
                          onChange={e => updateBucket(b.key, { compPct: +e.target.value || 0 })}
                          disabled={isBroker}
                          title={isBroker ? `Broker comp capped at ${BROKER_CAP}%` : `Range ${CORR_MIN}%–${CORR_MAX}%`}
                        />
                      </td>
                      <td className="px-2 align-top tabular-nums font-semibold">{c ? fmtUSD(c.loNetBeforeHoldback) : "—"}</td>
                      <td className="px-2 align-top tabular-nums text-accent">{c ? fmtUSD(c.teamHoldback) : "—"}</td>
                      <td className="pl-2 align-top tabular-nums font-semibold text-success">{c ? fmtUSD(c.initialLoCash) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-primary/20 bg-secondary/40 font-semibold">
                  <td className="py-3 pr-3">Totals</td>
                  <td className="px-2 tabular-nums">100%</td>
                  <td className="px-2 tabular-nums">{fmtUSD(state.annualVolume, { compact: true })}</td>
                  <td className="px-2"></td>
                  <td className="px-2"></td>
                  <td className="px-2 tabular-nums">{fmtUSD(calc.totals.loNetBeforeHoldback)}</td>
                  <td className="px-2 tabular-nums text-accent">{fmtUSD(calc.totals.teamHoldback)}</td>
                  <td className="pl-2 tabular-nums text-success">{fmtUSD(calc.totals.initialLoCash)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Files are allocated automatically from your Loan Type Mix. Broker fees are fixed at ${QM_FEE} (QM) and ${NONQM_FEE} (Non-QM). Correspondent uses a flat ${CORR_FEE} funding fee per file (no processing fee). Use the Correspondent toggles in the Comparison Tool above to route VA / Conventional / Non-QM through that channel.
          </p>
        </Section>


        {/* LO Economics Summary */}
        <Section icon={<Wallet className="h-5 w-5" />} title="LO Economics Summary">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="premium-card p-5"><Stat label="Total LO Net Before Holdback" value={fmtUSD(calc.totals.loNetBeforeHoldback)} /></div>
            <div className="premium-card p-5"><Stat label="Team-Support Holdback Collected" value={fmtUSD(calc.totals.teamHoldback)} accent="gold" /></div>
            <div className="premium-card p-5"><Stat label="Broker-Paid Team Costs" value={fmtUSD(calc.brokerPaidTotal)} /></div>
            <div className="premium-card p-5">
              <Stat
                label={calc.holdbackSurplus >= 0 ? "True-Up Surplus" : "Shortfall"}
                value={fmtUSD(calc.holdbackSurplus)}
                accent={calc.holdbackSurplus >= 0 ? "success" : "destructive"}
              />
            </div>
            
            <div className="premium-card p-5 bg-gradient-hero text-primary-foreground border-0">
              <span className="stat-label !text-accent">Final LO Net Annual Comp</span>
              <span className="stat-value !text-primary-foreground mt-1 block">{fmtUSD(calc.finalLoNetComp)}</span>
              <span className="text-sm text-primary-foreground/80 mt-1 block">{fmtUSD(calc.monthlyLoNet)} / month</span>
            </div>
          </div>

        </Section>




        <footer className="text-center text-xs text-muted-foreground py-8">
          Hometown Lending · LO Recruiting Pro Forma · All figures are illustrative and stored locally in your browser.
        </footer>
      </main>

      {/* Mobile sticky result bar — the headline number follows you while editing. */}
      <button
        type="button"
        onClick={() => document.getElementById("comparison")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        aria-label="Jump to comparison"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 hero-bg text-primary-foreground border-t border-accent/30 px-4 pt-2.5 text-left"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.625rem)" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-primary-foreground/70 font-semibold">HTL Net · Annual</p>
            <p className="text-xl font-bold tabular-nums leading-tight" style={{ color: "hsl(var(--success))" }}>{fmtUSD(calc.finalLoNetComp)}</p>
          </div>
          {calc.diffAnnual != null && (
            <div className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums ${(calc.diffAnnual ?? 0) >= 0 ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground"}`}>
              {(calc.diffAnnual ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffAnnual ?? 0)}
            </div>
          )}
        </div>
      </button>
    </div>
  );
};

export default Index;
