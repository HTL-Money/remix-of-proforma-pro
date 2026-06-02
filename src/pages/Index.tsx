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
  ModelState, defaultState, calculate, fmtUSD, fmtPct, fmtNum,
  BROKER_CAP, CORR_MIN, CORR_MAX, Bucket, Employee, ChannelKey, Role,
  ROLE_OPTIONS, PROCESSOR_DEFAULTS, PaySource,
  LOA_EXTRA_BONUS, LOAN_PARTNER_EXTRA_BONUS, QM_FEE, NONQM_FEE,
} from "@/lib/proforma";
import htlLogo from "@/assets/htl-logo.png.asset.json";

const STORAGE_KEY = "htl_lo_proforma_v4";

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
  return {
    name: "",
    role,
    salary: 0,
    salarySource: "HTL",
    qmBonus: 0,
    nonQmBonus: 0,
    bonusSource: "HTL",
    extraBonus: 0,
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

  // Auto-fill processor defaults when role flips to Processor
  useEffect(() => {
    if (role === "Processor") {
      setSalary(PROCESSOR_DEFAULTS.salary);
      setSalarySource(PROCESSOR_DEFAULTS.salarySource);
      setQmBonus(PROCESSOR_DEFAULTS.qmBonus);
      setNonQmBonus(PROCESSOR_DEFAULTS.nonQmBonus);
      setBonusSource(PROCESSOR_DEFAULTS.bonusSource);
      setExtraBonus(0);
    } else {
      setSalary(0);
      setQmBonus(0);
      setNonQmBonus(0);
      setExtraBonus(0);
    }
  }, [role]);

  const reset = () => {
    setRole("Processor"); setName("");
  };
  const submit = () => {
    onAdd({ name, role, salary, salarySource, qmBonus, nonQmBonus, bonusSource, extraBonus });
    reset();
    setOpen(false);
  };

  const isProcessor = role === "Processor";

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
            <div className="space-y-1">
              <Label className="text-xs">Annual Salary</Label>
              <Input type="number" value={salary} onChange={e => setSalary(+e.target.value || 0)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Salary Covered By</Label>
              <Select value={salarySource} onValueChange={v => setSalarySource(v as PaySource)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HTL">Hometown Lending</SelectItem>
                  <SelectItem value="Broker">Broker</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isProcessor && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">QM Per-File Bonus</Label>
                  <Input type="number" value={qmBonus} onChange={e => setQmBonus(+e.target.value || 0)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Non-QM Per-File Bonus</Label>
                  <Input type="number" value={nonQmBonus} onChange={e => setNonQmBonus(+e.target.value || 0)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Extra Per-File Bonus (Broker)</Label>
                  <Input type="number" value={extraBonus} onChange={e => setExtraBonus(+e.target.value || 0)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Bonus Covered By</Label>
                  <Select value={bonusSource} onValueChange={v => setBonusSource(v as PaySource)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HTL">Hometown Lending</SelectItem>
                      <SelectItem value="Broker">Broker</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>
          {isProcessor && (
            <p className="text-xs text-muted-foreground">
              The Extra Per-File Bonus is paid by the broker on top of the standard bonus and is automatically deducted from the LO's compensation.
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

  const totalBucketFiles = state.buckets.reduce((a, b) => a + (b.active ? b.fileCount : 0), 0);
  const fileMismatch = Math.abs(totalBucketFiles - state.annualFiles) > 0;
  const holdbackShortfall = calc.holdbackSurplus < 0;

  // When annual files changes, the delta lands in Broker QM
  const updateAnnualFiles = (next: number) => {
    setState(s => {
      const current = s.buckets.reduce((a, b) => a + (b.active ? b.fileCount : 0), 0);
      const delta = next - current;
      return {
        ...s,
        annualFiles: next,
        buckets: s.buckets.map(b =>
          b.key === "broker_qm" ? { ...b, fileCount: Math.max(0, Math.floor(b.fileCount + delta)) } : b
        ),
      };
    });
  };

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

  // Deactivating a bucket transfers its files to the matching Broker bucket
  const toggleBucketActive = (key: ChannelKey, active: boolean) => {
    setState(s => {
      const bucket = s.buckets.find(b => b.key === key);
      if (!bucket) return s;
      if (active || bucket.fileCount === 0 || key === "broker_qm" || key === "broker_nonqm") {
        return { ...s, buckets: s.buckets.map(b => b.key === key ? { ...b, active } : b) };
      }
      const targetKey: ChannelKey = bucket.loanType === "QM" ? "broker_qm" : "broker_nonqm";
      return {
        ...s,
        buckets: s.buckets.map(b => {
          if (b.key === key) return { ...b, active: false, fileCount: 0 };
          if (b.key === targetKey) return { ...b, fileCount: b.fileCount + bucket.fileCount };
          return b;
        }),
      };
    });
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="premium-card p-5">
            <Stat label="Annual Funded Volume" value={fmtUSD(state.annualVolume, { compact: true })} accent="primary" />
          </div>
          <div className="premium-card p-5">
            <Stat label="Funded Files" value={fmtNum(state.annualFiles)} />
          </div>
          <div className="premium-card p-5">
            <Stat label="Annual LO Net Compensation" value={fmtUSD(calc.finalLoNetComp)} accent="gold" />
          </div>
          <div className="premium-card p-5">
            <Stat label="Estimated Monthly LO Net" value={fmtUSD(calc.monthlyLoNet)} accent="success" />
          </div>
        </div>

        {/* Your Numbers */}
        <Section icon={<Calculator className="h-5 w-5" />} title="Your Numbers">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Loan Officer Name</Label>
              <Input value={state.recruitName} onChange={e => setState(s => ({ ...s, recruitName: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded Volume</Label>
              <Input
                type="number"
                value={state.annualVolume || ""}
                placeholder="48000000"
                onChange={e => setState(s => ({ ...s, annualVolume: +e.target.value || 0 }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded File Count</Label>
              <Input
                type="number"
                value={state.annualFiles || ""}
                placeholder="0"
                onChange={e => updateAnnualFiles(+e.target.value || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label>Average Loan Amount {state.avgLoanOverride && <span className="text-xs text-warning">(manual)</span>}</Label>
              <div className="flex gap-2">
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
              <Input type="number" step="0.1" value={state.loSplit} onChange={e => setState(s => ({ ...s, loSplit: +e.target.value || 0 }))} />
            </div>
            <div className="space-y-2">
              <Label>Current Platform Split (BPS)</Label>
              <Input
                type="number"
                step="1"
                value={state.currentSplit == null ? "" : Math.round(state.currentSplit * 50)}
                placeholder="e.g. 100 BPS = 2%"
                onChange={e => setState(s => ({ ...s, currentSplit: e.target.value === "" ? null : (+e.target.value || 0) / 50 }))}
              />
              {state.currentSplit != null && (
                <p className="text-xs text-muted-foreground">= {fmtPct(state.currentSplit)} of loan amount</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Team-Support Holdback</Label>
              <Select value={String(state.holdbackPct)} onValueChange={v => setState(s => ({ ...s, holdbackPct: +v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0%</SelectItem>
                  <SelectItem value="10">10%</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {fileMismatch && (
            <div className="mt-4">
              <Warn>Bucket file counts must equal total funded files ({fmtNum(state.annualFiles)}). Currently {fmtNum(totalBucketFiles)}.</Warn>
            </div>
          )}
        </Section>

        {/* Production buckets */}
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Production Buckets">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-3 pr-3 font-semibold">Bucket</th>
                  <th className="py-3 px-2 font-semibold">Active</th>
                  <th className="py-3 px-2 font-semibold">Files</th>
                  <th className="py-3 px-2 font-semibold">Vol %</th>
                  <th className="py-3 px-2 font-semibold">$ Volume</th>
                  <th className="py-3 px-2 font-semibold">Avg Loan</th>
                  <th className="py-3 px-2 font-semibold">Comp %</th>
                  <th className="py-3 px-2 font-semibold">Per-File Fee</th>
                  <th className="py-3 px-2 font-semibold">LO Net Pre-Holdback</th>
                  <th className="py-3 px-2 font-semibold">Holdback</th>
                  <th className="py-3 pl-2 font-semibold">Initial LO Cash</th>
                </tr>
              </thead>
              <tbody>
                {state.buckets.map(b => {
                  const c = calc.buckets.find(x => x.bucket.key === b.key);
                  const isBroker = b.channel === "Broker";
                  return (
                    <tr key={b.key} className={`border-b border-border/60 ${!b.active ? "opacity-50" : ""}`}>
                      <td className="py-3 pr-3 align-top">
                        <div className="font-semibold text-primary">{b.label}</div>
                        <div className="text-xs text-muted-foreground">{b.channel} · {b.loanType}</div>
                      </td>
                      <td className="px-2 align-top"><Switch checked={b.active} onCheckedChange={v => toggleBucketActive(b.key, v)} /></td>
                      <td className="px-2 align-top"><Input className="w-24" type="number" value={b.fileCount} onChange={e => updateBucket(b.key, { fileCount: +e.target.value || 0 })} disabled={!b.active} /></td>
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
                          disabled={isBroker || !b.active}
                          title={isBroker ? `Broker comp capped at ${BROKER_CAP}%` : `Range ${CORR_MIN}%–${CORR_MAX}%`}
                        />
                      </td>
                      <td className="px-2 align-top"><Input className="w-24" type="number" value={b.perFileFee} onChange={e => updateBucket(b.key, { perFileFee: +e.target.value || 0 })} disabled={!b.active} /></td>
                      <td className="px-2 align-top tabular-nums font-semibold">{c ? fmtUSD(c.loNetBeforeHoldback) : "—"}</td>
                      <td className="px-2 align-top tabular-nums text-accent">{c ? fmtUSD(c.teamHoldback) : "—"}</td>
                      <td className="pl-2 align-top tabular-nums font-semibold text-success">{c ? fmtUSD(c.initialLoCash) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-primary/20 bg-secondary/40 font-semibold">
                  <td className="py-3 pr-3" colSpan={2}>Totals</td>
                  <td className="px-2 tabular-nums">{fmtNum(totalBucketFiles)}</td>
                  <td className="px-2 tabular-nums">100%</td>
                  <td className="px-2 tabular-nums">{fmtUSD(state.annualVolume, { compact: true })}</td>
                  <td className="px-2"></td>
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
            Volume % is derived from file counts. Broker comp is capped at {BROKER_CAP}%. Correspondent comp must be between {CORR_MIN}% and {CORR_MAX}%. Deactivating a channel moves its files to the matching Broker bucket.
          </p>
        </Section>

        {/* Team builder */}
        <Section
          icon={<Users className="h-5 w-5" />}
          title="Team & Employee Support"
          right={<AddEmployeeDialog onAdd={(emp) => setState(s => ({ ...s, employees: [...s.employees, { id: crypto.randomUUID(), ...emp }] }))} />}
        >
          <p className="text-sm text-muted-foreground mb-4">
            <span className="font-medium text-foreground">Covered by Broker</span> means this cost is reconciled through the LO's team-support holdback. <span className="font-medium text-foreground">Covered by Hometown Lending</span> means HTL absorbs the cost.
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
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input value={e.name} onChange={ev => updateEmployee(e.id, { name: ev.target.value })} placeholder="Name" />
                  </div>
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-xs">Role / Title</Label>
                    <Select value={ROLE_OPTIONS.includes(e.role as Role) ? e.role : "Processor"} onValueChange={v => {
                      // when switching role, clear processor-only fields if leaving processor
                      if (v !== "Processor" && isProcessor) {
                        updateEmployee(e.id, { role: v, qmBonus: 0, nonQmBonus: 0, extraBonus: 0 });
                      } else if (v === "Processor" && !isProcessor) {
                        updateEmployee(e.id, { role: v, qmBonus: PROCESSOR_DEFAULTS.qmBonus, nonQmBonus: PROCESSOR_DEFAULTS.nonQmBonus });
                      } else {
                        updateEmployee(e.id, { role: v });
                      }
                    }}>
                      <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-xs">Annual Salary</Label>
                    <Input type="number" value={e.salary} onChange={ev => updateEmployee(e.id, { salary: +ev.target.value || 0 })} />
                  </div>
                  <div className="md:col-span-2 space-y-1">
                    <Label className="text-xs">Salary Covered By</Label>
                    <Select value={e.salarySource} onValueChange={v => updateEmployee(e.id, { salarySource: v as PaySource })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="HTL">Hometown Lending</SelectItem>
                        <SelectItem value="Broker">Broker</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {isProcessor ? (
                    <>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs">QM/file</Label>
                        <Input type="number" value={e.qmBonus} onChange={ev => updateEmployee(e.id, { qmBonus: +ev.target.value || 0 })} />
                      </div>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs">Non-QM/file</Label>
                        <Input type="number" value={e.nonQmBonus} onChange={ev => updateEmployee(e.id, { nonQmBonus: +ev.target.value || 0 })} />
                      </div>
                      <div className="md:col-span-1 space-y-1">
                        <Label className="text-xs" title="Extra per-file bonus paid by broker on top">Extra/file</Label>
                        <Input type="number" value={e.extraBonus} onChange={ev => updateEmployee(e.id, { extraBonus: +ev.target.value || 0 })} />
                      </div>
                      <div className="md:col-span-1 flex items-end">
                        <Button variant="ghost" size="icon" onClick={() => removeEmployee(e.id)} className="text-destructive hover:bg-destructive/10">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="md:col-span-4 flex items-end justify-end">
                      <Button variant="ghost" size="icon" onClick={() => removeEmployee(e.id)} className="text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="premium-card p-4"><Stat label="Broker-Paid Salaries" value={fmtUSD(calc.brokerPaidSalaries)} /></div>
            <div className="premium-card p-4"><Stat label="Broker-Paid Bonuses" value={fmtUSD(calc.brokerPaidBonuses + calc.extraBonusTotal)} /></div>
            <div className="premium-card p-4"><Stat label="HTL-Paid Salaries" value={fmtUSD(calc.htlPaidSalaries)} accent="gold" /></div>
            <div className="premium-card p-4"><Stat label="HTL-Paid Bonuses" value={fmtUSD(calc.htlPaidBonuses)} accent="gold" /></div>
          </div>
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
            <div className="premium-card p-5"><Stat label="HTL-Paid Support Value" value={fmtUSD(calc.htlPaidTotal)} accent="gold" /></div>
            <div className="premium-card p-5 bg-gradient-hero text-primary-foreground border-0">
              <span className="stat-label !text-accent">Final LO Net Annual Comp</span>
              <span className="stat-value !text-primary-foreground mt-1 block">{fmtUSD(calc.finalLoNetComp)}</span>
              <span className="text-sm text-primary-foreground/80 mt-1 block">{fmtUSD(calc.monthlyLoNet)} / month</span>
            </div>
          </div>

          {holdbackShortfall && (
            <div className="mt-4"><Warn>Holdback does not cover broker-paid support costs. Shortfall of {fmtUSD(Math.abs(calc.holdbackSurplus))} will be deducted from LO payout.</Warn></div>
          )}
        </Section>

        {/* Comparison */}
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Comparison Tool">
          {state.currentSplit == null ? (
            <p className="text-sm text-muted-foreground">Enter your <span className="font-medium text-foreground">Current Platform Split %</span> above to see a side-by-side comparison. Current platform earnings are calculated as <em>volume × split − broker-paid salaries</em>.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="premium-card p-5">
                <p className="stat-label">Current Platform ({fmtPct(state.currentSplit, 1)} split)</p>
                <p className="stat-value text-foreground mt-1">{fmtUSD(calc.currentPlatformAnnual ?? 0)}</p>
                <p className="text-xs text-muted-foreground mt-1">{fmtUSD(calc.currentPlatformMonthly ?? 0)} / month</p>
                {calc.brokerPaidSalaries > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">Less {fmtUSD(calc.brokerPaidSalaries)} broker-paid salaries</p>
                )}
              </div>
              <div className="premium-card p-5 bg-gradient-hero text-primary-foreground border-0">
                <p className="stat-label !text-accent">Hometown Lending</p>
                <p className="stat-value !text-primary-foreground mt-1">{fmtUSD(calc.htlAnnual)}</p>
                <p className="text-xs text-primary-foreground/80 mt-1">{fmtUSD(calc.htlMonthly)} / month</p>
              </div>
              <div className="premium-card p-5">
                <p className="stat-label">Annual Difference</p>
                <p className={`stat-value mt-1 ${(calc.diffAnnual ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>
                  {(calc.diffAnnual ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffAnnual ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{(calc.diffMonthly ?? 0) >= 0 ? "+" : ""}{fmtUSD(calc.diffMonthly ?? 0)} / month</p>
              </div>
            </div>
          )}
        </Section>

        <footer className="text-center text-xs text-muted-foreground py-8">
          Hometown Lending · LO Recruiting Pro Forma · All figures are illustrative and stored locally in your browser.
        </footer>
      </main>
    </div>
  );
};

export default Index;
