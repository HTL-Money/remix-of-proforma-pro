import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Trash2, TrendingUp, AlertTriangle, Wallet, Users, Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  ModelState, defaultState, calculate, calculateBrokerOnly, fmtUSD, fmtPct, fmtNum,
  BROKER_CAP, CORR_MIN, CORR_MAX, Bucket, Employee, ChannelKey, Role,
  ROLE_OPTIONS, PROCESSOR_DEFAULTS, PaySource,
  LOA_EXTRA_BONUS, LOAN_PARTNER_EXTRA_BONUS, QM_FEE, NONQM_FEE, CORR_FEE,
} from "@/lib/proforma";
import htlLogo from "@/assets/htl-logo.png.asset.json";

const STORAGE_KEY = "htl_lo_proforma_v6";

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

const Section: React.FC<{ icon?: React.ReactNode; title: string; children: React.ReactNode; right?: React.ReactNode }> = ({ icon, title, children, right }) => (
  <section className="premium-card p-6 md:p-8">
    <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
      <h2 className="section-header !mb-0 !border-0 !pb-0">{icon}{title}</h2>
      {right}
    </div>
    {children}
  </section>
);

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
                  <Input type="number" value={salary} onChange={e => setSalary(+e.target.value || 0)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">QM Per-File Bonus (HTL-paid)</Label>
                  <Input type="number" value={qmBonus} onChange={e => setQmBonus(+e.target.value || 0)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Non-QM Per-File Bonus (HTL-paid)</Label>
                  <Input type="number" value={nonQmBonus} onChange={e => setNonQmBonus(+e.target.value || 0)} />
                </div>
              </>
            )}
            {isSupport && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Annual Salary</Label>
                  <Input type="number" value={salary} onChange={e => setSalary(+e.target.value || 0)} />
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
                  <Input type="number" value={extraBonus} onChange={e => setExtraBonus(+e.target.value || 0)} />
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
  const [state, setState] = useState<ModelState>(() => loadState());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

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
    if (confirm("Reset model to defaults? This clears all inputs.")) {
      setState(defaultState());
      toast({ title: "Model reset", description: "All inputs restored to defaults." });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Hero header */}
      <header className="hero-bg text-primary-foreground border-b border-border/40">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 md:py-10">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-lg bg-white flex items-center justify-center shadow-soft p-1.5">
                <img src={htlLogo.url} alt="Hometown Lending" className="h-full w-full object-contain" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-accent font-semibold">Hometown Lending</p>
                <h1 className="font-display text-3xl md:text-4xl font-bold leading-tight">LO Recruiting Pro Forma</h1>
                <p className="text-sm text-primary-foreground/70 mt-1">See what your production is worth at Hometown Lending.</p>
              </div>
            </div>

            <Button onClick={reset} variant="outline" size="sm" className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground">
              <RotateCcw className="h-4 w-4 mr-2" /> Reset
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
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


        {/* Your Numbers */}
        <Section icon={<Calculator className="h-5 w-5" />} title="Production Numbers">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Loan Officer Name</Label>
              <Input className="max-w-[200px]" value={state.recruitName} onChange={e => setState(s => ({ ...s, recruitName: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded Volume</Label>
              <Input
                className="max-w-[200px]"
                type="number"
                value={state.annualVolume || ""}
                placeholder="48000000"
                onChange={e => setState(s => ({ ...s, annualVolume: +e.target.value || 0 }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded File Count</Label>
              <Input
                className="max-w-[200px]"
                type="number"
                value={state.annualFiles || ""}
                placeholder="0"
                onChange={e => setState(s => ({ ...s, annualFiles: +e.target.value || 0 }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Average Loan Amount {state.avgLoanOverride && <span className="text-xs text-warning">(manual)</span>}</Label>
              <div className="flex gap-2 max-w-[200px]">
                <Input
                  type="number"
                  value={Math.round(state.avgLoanAmount)}
                  onChange={e => setState(s => ({ ...s, avgLoanAmount: +e.target.value || 0, avgLoanOverride: true }))}
                />
                {state.avgLoanOverride && (
                  <Button variant="outline" size="sm" onClick={() => setState(s => ({ ...s, avgLoanOverride: false }))}>Auto</Button>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>HTL LO Split (%)</Label>
              <div className="max-w-[200px]">
                <Select value={String(state.loSplit)} onValueChange={v => setState(s => ({ ...s, loSplit: +v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="90">90%</SelectItem>
                    <SelectItem value="85">85%</SelectItem>
                    <SelectItem value="80">80%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Team-Support Holdback</Label>
              <div className="max-w-[200px]">
                <Select value={String(state.holdbackPct)} onValueChange={v => setState(s => ({ ...s, holdbackPct: +v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0%</SelectItem>
                    <SelectItem value="10">10%</SelectItem>
                    <SelectItem value="20">20%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2 lg:col-span-4">
              <Label>Loan Type Mix (%)</Label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl">
                {(["fha","va","conv","nonqm"] as const).map(k => {
                  const labels: Record<typeof k, string> = { fha: "FHA", va: "VA", conv: "Conventional", nonqm: "Non-QM" } as any;
                  return (
                    <div key={k} className="space-y-1">
                      <Label className="text-xs">{labels[k]}</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="1"
                        value={state.loanTypeMix[k]}
                        onChange={e => setState(s => ({ ...s, loanTypeMix: { ...s.loanTypeMix, [k]: Math.min(100, Math.max(0, +e.target.value || 0)) } }))}
                      />
                    </div>
                  );
                })}
              </div>
              {(() => {
                const sum = state.loanTypeMix.fha + state.loanTypeMix.va + state.loanTypeMix.conv + state.loanTypeMix.nonqm;
                return (
                  <p className={`text-xs ${sum === 100 ? "text-muted-foreground" : "text-warning"}`}>
                    Mix totals {sum}%{sum !== 100 ? " — should equal 100%." : "."} FHA stays Broker (2.75% cap). VA & Conventional route to Correspondent when active; otherwise Broker. Non-QM routes to Correspondent Non-QM when active.
                  </p>
                );
              })()}
            </div>
          </div>
        </Section>

        {/* Comparison Tool */}
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Comparison Tool">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="space-y-2">
              <Label>Your LO BPS on Current Platform</Label>
              <div className="flex items-center gap-3">
                <Input
                  className="w-32"
                  type="number"
                  step="1"
                  min={0}
                  max={275}
                  value={state.currentSplit == null ? "" : Math.round(state.currentSplit * 100)}
                  placeholder="e.g. 200"
                  onChange={e => setState(s => ({ ...s, currentSplit: e.target.value === "" ? null : (+e.target.value || 0) / 100 }))}
                />
                {state.currentSplit != null && (
                  <span className="text-sm font-semibold text-accent tabular-nums">= {fmtPct(state.currentSplit, 2)}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Enter a 3-digit BPS value (e.g. 200 = 2.00%). 100 BPS = 1% of the loan amount. The platform takes 2.75% (275 BPS) gross; you receive your BPS.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Add Correspondent Channels</Label>
              <div className="grid grid-cols-2 gap-2">
                {state.buckets.filter(b => b.channel === "Correspondent").map(b => (
                  <label key={b.key} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs cursor-pointer">
                    <Switch checked={b.active} onCheckedChange={v => updateBucket(b.key, { active: v })} />
                    <span className="font-medium">{b.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Turn on Correspondent to route VA / Conventional (QM) and Non-QM through that channel at {fmtUSD(CORR_FEE)} / file (no processing fee). FHA always stays Broker.
              </p>
            </div>
          </div>

          {state.currentSplit == null ? (
            <p className="text-sm text-muted-foreground">Enter your <span className="font-medium text-foreground">LO BPS</span> above to see a side-by-side comparison.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Current platform */}
                <div className="premium-card p-5">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Current Platform</p>
                  <p className="stat-label mt-1">{Math.round(state.currentSplit * 100)} BPS · {fmtPct(state.currentSplit, 2)}</p>
                  <p className="stat-value text-foreground mt-1">{fmtUSD(calc.currentPlatformAnnual ?? 0)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{fmtUSD(calc.currentPlatformMonthly ?? 0)} / month</p>
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground border-t border-border pt-3">
                    <div className="flex justify-between"><span>Broker gross (2.75%)</span><span className="tabular-nums">{fmtUSD(state.annualVolume * 0.0275)}</span></div>
                    <div className="flex justify-between"><span>LO comp ({Math.round(state.currentSplit * 100)} BPS)</span><span className="tabular-nums">{fmtUSD(state.annualVolume * (state.currentSplit / 100))}</span></div>
                    {calc.brokerPaidSalaries > 0 && (
                      <div className="flex justify-between text-destructive"><span>Less broker-paid salaries</span><span className="tabular-nums">−{fmtUSD(calc.brokerPaidSalaries)}</span></div>
                    )}
                  </div>
                </div>

                {/* HTL — Broker only */}
                <div className="premium-card p-5">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Hometown Lending</p>
                  <p className="stat-label mt-1">Broker Only</p>
                  <p className="stat-value text-primary mt-1">{fmtUSD(calcBrokerOnly.finalLoNetComp)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{fmtUSD(calcBrokerOnly.monthlyLoNet)} / month</p>
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground border-t border-border pt-3">
                    <div className="flex justify-between"><span>vs Current Platform</span><span className={`tabular-nums font-semibold ${(calcBrokerOnly.finalLoNetComp - (calc.currentPlatformAnnual ?? 0)) >= 0 ? "text-success" : "text-destructive"}`}>{(calcBrokerOnly.finalLoNetComp - (calc.currentPlatformAnnual ?? 0)) >= 0 ? "+" : ""}{fmtUSD(calcBrokerOnly.finalLoNetComp - (calc.currentPlatformAnnual ?? 0))}</span></div>
                  </div>
                </div>

                {/* HTL — With correspondent */}
                <div className={`premium-card p-5 border-0 ${corrActive ? "bg-primary text-primary-foreground" : "bg-secondary/30"}`}>
                  <p className={`text-xs uppercase tracking-wider font-semibold ${corrActive ? "!text-accent" : "text-muted-foreground"}`}>Hometown Lending</p>
                  <p className={`stat-label mt-1 ${corrActive ? "!text-primary-foreground/80" : ""}`}>With Correspondent</p>
                  <p className={`stat-value mt-1 ${corrActive ? "!text-accent" : "text-muted-foreground"}`}>{fmtUSD(calc.finalLoNetComp)}</p>
                  <p className={`text-xs mt-1 ${corrActive ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{fmtUSD(calc.monthlyLoNet)} / month</p>
                  <div className={`mt-3 space-y-1 text-xs border-t pt-3 ${corrActive ? "text-primary-foreground/80 border-primary-foreground/20" : "text-muted-foreground border-border"}`}>
                    <div className="flex justify-between"><span>Correspondent uplift</span><span className={`tabular-nums font-semibold ${corrActive ? "!text-accent" : ""}`}>{corrUplift >= 0 ? "+" : ""}{fmtUSD(corrUplift)}</span></div>
                    <div className="flex justify-between"><span>vs Current Platform</span><span className={`tabular-nums font-semibold ${(calc.diffAnnual ?? 0) >= 0 ? (corrActive ? "!text-accent" : "text-success") : "text-destructive"}`}>{(calc.diffAnnual ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffAnnual ?? 0)}</span></div>
                  </div>
                  {!corrActive && (
                    <p className="text-xs text-muted-foreground mt-2 italic">Turn on a Correspondent channel above to see the uplift.</p>
                  )}
                </div>
              </div>
            </>
          )}
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
                {state.buckets.filter(b => b.active).map(b => {
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
                          step="0.01"
                          min={isBroker ? 0 : CORR_MIN}
                          max={isBroker ? BROKER_CAP : CORR_MAX}
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

        {/* Team builder */}
        <Section
          icon={<Users className="h-5 w-5" />}
          title="Team & Employee Support"
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
                        <Input type="number" value={e.salary} onChange={ev => updateEmployee(e.id, { salary: +ev.target.value || 0 })} />
                      </div>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs">QM/file</Label>
                        <Input type="number" value={e.qmBonus} onChange={ev => updateEmployee(e.id, { qmBonus: +ev.target.value || 0 })} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Non-QM/file</Label>
                        <Input type="number" value={e.nonQmBonus} onChange={ev => updateEmployee(e.id, { nonQmBonus: +ev.target.value || 0 })} />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="md:col-span-2 space-y-1">
                        <Label className="text-xs">Annual Salary</Label>
                        <Input type="number" value={e.salary} onChange={ev => updateEmployee(e.id, { salary: +ev.target.value || 0 })} />
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
                        <Input type="number" value={e.extraBonus} onChange={ev => updateEmployee(e.id, { extraBonus: +ev.target.value || 0 })} />
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
    </div>
  );
};

export default Index;
