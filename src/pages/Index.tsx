import { useEffect, useMemo, useState } from "react";
import { Building2, Plus, RotateCcw, Trash2, TrendingUp, AlertTriangle, Eye, EyeOff, Wallet, Users, Calculator, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import {
  ModelState, defaultState, calculate, fmtUSD, fmtPct, fmtNum,
  BROKER_CAP, CORR_MIN, CORR_MAX, Bucket, Employee, ChannelKey,
} from "@/lib/proforma";
import htlLogo from "@/assets/htl-logo.png.asset.json";

const STORAGE_KEY = "htl_lo_proforma_v2";
type Mode = "recruit" | "internal";

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

// ---- Main page ----
const Index = () => {
  const [state, setState] = useState<ModelState>(() => loadState());
  const [mode, setMode] = useState<Mode>("recruit");

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

  // Validations
  const totalBucketFiles = state.buckets.reduce((a, b) => a + (b.active ? b.fileCount : 0), 0);
  const totalBucketPct = state.buckets.reduce((a, b) => a + (b.active ? b.volumePct : 0), 0);
  const fileMismatch = Math.abs(totalBucketFiles - state.annualFiles) > 0;
  const pctMismatch = Math.abs(totalBucketPct - 100) > 0.01;
  const holdbackShortfall = calc.holdbackSurplus < 0;

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

  const addEmployee = () => {
    setState(s => ({
      ...s,
      employees: [...s.employees, { id: crypto.randomUUID(), name: "", role: "", salary: 0, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker" }],
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
                <p className="text-sm text-primary-foreground/70 mt-1">Executive compensation &amp; internal profitability model</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="inline-flex rounded-lg border border-accent/30 bg-primary-foreground/5 p-1">
                <button
                  onClick={() => setMode("recruit")}
                  className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${mode === "recruit" ? "bg-accent text-accent-foreground shadow-gold" : "text-primary-foreground/80 hover:text-primary-foreground"}`}
                >
                  <Eye className="h-4 w-4" /> Recruit Mode
                </button>
                <button
                  onClick={() => setMode("internal")}
                  className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${mode === "internal" ? "bg-accent text-accent-foreground shadow-gold" : "text-primary-foreground/80 hover:text-primary-foreground"}`}
                >
                  <EyeOff className="h-4 w-4" /> Internal Mode
                </button>
              </div>
              <Button onClick={reset} variant="outline" size="sm" className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground">
                <RotateCcw className="h-4 w-4 mr-2" /> Reset
              </Button>
            </div>
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
            <Stat label="HTL Annual LO Net Comp" value={fmtUSD(calc.finalLoNetComp)} accent="gold" />
          </div>
          <div className="premium-card p-5">
            <Stat label="Estimated Monthly LO Net" value={fmtUSD(calc.monthlyLoNet)} accent="success" />
          </div>
        </div>

        {/* Global inputs */}
        <Section icon={<Calculator className="h-5 w-5" />} title="Global Inputs">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Recruit / LO Name</Label>
              <Input value={state.recruitName} onChange={e => setState(s => ({ ...s, recruitName: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Scenario Name</Label>
              <Input value={state.scenarioName} onChange={e => setState(s => ({ ...s, scenarioName: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded Volume</Label>
              <Input type="number" value={state.annualVolume} onChange={e => setState(s => ({ ...s, annualVolume: +e.target.value || 0 }))} />
            </div>
            <div className="space-y-2">
              <Label>Annual Funded File Count</Label>
              <Input type="number" value={state.annualFiles} onChange={e => setState(s => ({ ...s, annualFiles: +e.target.value || 0 }))} />
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
              <Label>Current Platform Split (%)</Label>
              <Input
                type="number"
                step="0.1"
                value={state.currentSplit ?? ""}
                placeholder="Leave blank if unknown"
                onChange={e => setState(s => ({ ...s, currentSplit: e.target.value === "" ? null : +e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Team-Support Holdback</Label>
              <Select value={String(state.holdbackPct)} onValueChange={v => setState(s => ({ ...s, holdbackPct: +v as 10 | 20 | 30 }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10%</SelectItem>
                  <SelectItem value="20">20%</SelectItem>
                  <SelectItem value="30">30%</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>QM % (helper) — Non-QM = {fmtPct(100 - state.qmPctHelper, 0)}</Label>
              <Input type="number" min={0} max={100} value={state.qmPctHelper} onChange={e => setState(s => ({ ...s, qmPctHelper: Math.min(100, Math.max(0, +e.target.value || 0)) }))} />
            </div>
          </div>

          {(fileMismatch || pctMismatch) && (
            <div className="mt-4 space-y-2">
              {fileMismatch && <Warn>Bucket file counts must equal total funded files ({fmtNum(state.annualFiles)}). Currently {fmtNum(totalBucketFiles)}.</Warn>}
              {pctMismatch && <Warn>Bucket volume percentages must equal 100%. Currently {fmtPct(totalBucketPct, 2)}.</Warn>}
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
                  {mode === "internal" && <th className="py-3 px-2 font-semibold">Channel Fees</th>}
                  {mode === "internal" && <th className="py-3 px-2 font-semibold">Gross Rev</th>}
                  {mode === "internal" && <th className="py-3 px-2 font-semibold">LO Split $</th>}
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
                      <td className="px-2 align-top"><Switch checked={b.active} onCheckedChange={v => updateBucket(b.key, { active: v })} /></td>
                      <td className="px-2 align-top"><Input className="w-24" type="number" value={b.fileCount} onChange={e => updateBucket(b.key, { fileCount: +e.target.value || 0 })} /></td>
                      <td className="px-2 align-top"><Input className="w-20" type="number" step="0.1" value={b.volumePct} onChange={e => updateBucket(b.key, { volumePct: +e.target.value || 0 })} /></td>
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
                      <td className="px-2 align-top"><Input className="w-24" type="number" value={b.perFileFee} onChange={e => updateBucket(b.key, { perFileFee: +e.target.value || 0 })} /></td>
                      {mode === "internal" && <td className="px-2 align-top tabular-nums">{c ? fmtUSD(c.channelFees) : "—"}</td>}
                      {mode === "internal" && <td className="px-2 align-top tabular-nums">{c ? fmtUSD(c.grossRevenue) : "—"}</td>}
                      {mode === "internal" && <td className="px-2 align-top tabular-nums">{c ? fmtUSD(c.loGrossSplit) : "—"}</td>}
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
                  <td className="px-2 tabular-nums">{fmtPct(totalBucketPct, 1)}</td>
                  <td className="px-2 tabular-nums">{fmtUSD(state.annualVolume, { compact: true })}</td>
                  <td className="px-2"></td>
                  <td className="px-2"></td>
                  <td className="px-2"></td>
                  {mode === "internal" && <td className="px-2 tabular-nums">{fmtUSD(calc.totals.channelFees)}</td>}
                  {mode === "internal" && <td className="px-2 tabular-nums">{fmtUSD(calc.totals.grossRevenue)}</td>}
                  {mode === "internal" && <td className="px-2 tabular-nums">{fmtUSD(calc.totals.loGrossSplit)}</td>}
                  <td className="px-2 tabular-nums">{fmtUSD(calc.totals.loNetBeforeHoldback)}</td>
                  <td className="px-2 tabular-nums text-accent">{fmtUSD(calc.totals.teamHoldback)}</td>
                  <td className="pl-2 tabular-nums text-success">{fmtUSD(calc.totals.initialLoCash)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Broker comp is capped at {BROKER_CAP}%. Correspondent comp must be between {CORR_MIN}% and {CORR_MAX}%.
          </p>
        </Section>

        {/* Team builder */}
        <Section
          icon={<Users className="h-5 w-5" />}
          title="Team & Employee Support"
          right={<Button onClick={addEmployee} size="sm" className="gold-accent text-accent-foreground hover:opacity-90"><Plus className="h-4 w-4 mr-1" /> Add Employee</Button>}
        >
          <p className="text-sm text-muted-foreground mb-4">
            <span className="font-medium text-foreground">Paid by Broker</span> means this cost is reconciled through the LO's team-support holdback. <span className="font-medium text-foreground">Paid by HTL</span> means Hometown Lending absorbs the cost.
          </p>
          <div className="space-y-3">
            {state.employees.map(e => (
              <div key={e.id} className="grid grid-cols-1 md:grid-cols-12 gap-3 p-4 rounded-lg border border-border bg-secondary/30">
                <div className="md:col-span-2 space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input value={e.name} onChange={ev => updateEmployee(e.id, { name: ev.target.value })} placeholder="Optional" />
                </div>
                <div className="md:col-span-2 space-y-1">
                  <Label className="text-xs">Role / Title</Label>
                  <Select value={e.role} onValueChange={v => updateEmployee(e.id, { role: v })}>
                    <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LOA">LOA</SelectItem>
                      <SelectItem value="Loan Partner">Loan Partner</SelectItem>
                      <SelectItem value="Processor">Processor</SelectItem>
                      <SelectItem value="Junior Processor">Junior Processor</SelectItem>
                      <SelectItem value="Underwriter">Underwriter</SelectItem>
                      <SelectItem value="Closer">Closer</SelectItem>
                      <SelectItem value="Marketing">Marketing</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2 space-y-1">
                  <Label className="text-xs">Annual Salary</Label>
                  <Input type="number" value={e.salary} onChange={ev => updateEmployee(e.id, { salary: +ev.target.value || 0 })} />
                </div>
                <div className="md:col-span-2 space-y-1">
                  <Label className="text-xs">Salary Source</Label>
                  <Select value={e.salarySource} onValueChange={v => updateEmployee(e.id, { salarySource: v as "HTL" | "Broker" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Broker">Paid by Broker</SelectItem>
                      <SelectItem value="HTL">Paid by HTL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-1 space-y-1">
                  <Label className="text-xs">QM/file</Label>
                  <Input type="number" value={e.qmBonus} onChange={ev => updateEmployee(e.id, { qmBonus: +ev.target.value || 0 })} />
                </div>
                <div className="md:col-span-1 space-y-1">
                  <Label className="text-xs">Non-QM/file</Label>
                  <Input type="number" value={e.nonQmBonus} onChange={ev => updateEmployee(e.id, { nonQmBonus: +ev.target.value || 0 })} />
                </div>
                <div className="md:col-span-1 space-y-1">
                  <Label className="text-xs">Bonus Src</Label>
                  <Select value={e.bonusSource} onValueChange={v => updateEmployee(e.id, { bonusSource: v as "HTL" | "Broker" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Broker">Broker</SelectItem>
                      <SelectItem value="HTL">HTL</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-1 flex items-end">
                  <Button variant="ghost" size="icon" onClick={() => removeEmployee(e.id)} className="text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="premium-card p-4"><Stat label="Broker-Paid Salaries" value={fmtUSD(calc.brokerPaidSalaries)} /></div>
            <div className="premium-card p-4"><Stat label="Broker-Paid Bonuses" value={fmtUSD(calc.brokerPaidBonuses)} /></div>
            <div className="premium-card p-4"><Stat label="Paid by HTL Salaries" value={fmtUSD(calc.htlPaidSalaries)} accent="gold" /></div>
            <div className="premium-card p-4"><Stat label="Paid by HTL Bonuses" value={fmtUSD(calc.htlPaidBonuses)} accent="gold" /></div>
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
            <div className="premium-card p-5"><Stat label="Paid by HTL Support Value" value={fmtUSD(calc.htlPaidTotal)} accent="gold" /></div>
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
        <Section icon={<TrendingUp className="h-5 w-5" />} title="Current Platform vs Hometown Lending">
          {state.currentSplit == null ? (
            <p className="text-sm text-muted-foreground">Enter the LO's <span className="font-medium text-foreground">Current Platform Split %</span> above to see a side-by-side comparison.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="premium-card p-5">
                <p className="stat-label">Current Platform ({fmtPct(state.currentSplit, 1)} split)</p>
                <p className="stat-value text-foreground mt-1">{fmtUSD(calc.currentPlatformAnnual ?? 0)}</p>
                <p className="text-xs text-muted-foreground mt-1">{fmtUSD(calc.currentPlatformMonthly ?? 0)} / month</p>
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

        {/* Internal-only sections */}
        {mode === "internal" && (
          <>
            <Section icon={<Shield className="h-5 w-5" />} title="Required Holdback Analysis">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="premium-card p-5"><Stat label="Selected Holdback" value={fmtPct(state.holdbackPct, 0)} /></div>
                <div className="premium-card p-5"><Stat label="Required Holdback" value={fmtPct(calc.requiredHoldbackPct, 2)} accent={calc.requiredHoldbackPct > state.holdbackPct ? "warning" : "success"} /></div>
                <div className="premium-card p-5"><Stat label="Surplus / Shortfall" value={fmtUSD(calc.holdbackSurplus)} accent={calc.holdbackSurplus >= 0 ? "success" : "destructive"} /></div>
                <div className="premium-card p-5">
                  <span className="stat-label">Recommendation</span>
                  <p className="mt-2 text-sm font-medium">
                    {calc.requiredHoldbackPct <= state.holdbackPct
                      ? "Current holdback is sufficient."
                      : `Increase holdback to ${calc.requiredHoldbackPct <= 10 ? "10%" : calc.requiredHoldbackPct <= 20 ? "20%" : "30%"}.`}
                  </p>
                </div>
              </div>
            </Section>

            <Section icon={<Building2 className="h-5 w-5" />} title="Internal Company P&L">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="premium-card p-5"><Stat label="Total Gross Revenue" value={fmtUSD(calc.totals.grossRevenue)} /></div>
                <div className="premium-card p-5"><Stat label="LO Payout (Gross Split)" value={fmtUSD(calc.totals.loGrossSplit)} /></div>
                <div className="premium-card p-5"><Stat label="HTL Retained Split" value={fmtUSD(calc.totals.htlRetained)} accent="gold" /></div>
                <div className="premium-card p-5"><Stat label="Channel Fees" value={fmtUSD(calc.totals.channelFees)} /></div>
                <div className="premium-card p-5"><Stat label="Paid by HTL Total" value={fmtUSD(calc.htlPaidTotal)} accent="warning" /></div>
                <div className="premium-card p-5"><Stat label="Management Salary" value={fmtUSD(calc.managementSalary)} /></div>
              </div>

              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">HTL Retained Split</td><td className="py-3 px-4 text-right tabular-nums">{fmtUSD(calc.totals.htlRetained)}</td></tr>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">Less: Paid by HTL Salaries</td><td className="py-3 px-4 text-right tabular-nums">({fmtUSD(calc.htlPaidSalaries)})</td></tr>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">Less: Paid by HTL Bonuses</td><td className="py-3 px-4 text-right tabular-nums">({fmtUSD(calc.htlPaidBonuses)})</td></tr>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">Less: Management Salary ($5,000 / mo)</td><td className="py-3 px-4 text-right tabular-nums">({fmtUSD(calc.managementSalary)})</td></tr>
                    <tr className="border-b border-border bg-secondary/40 font-semibold"><td className="py-3 px-4">Net Profit Before Profit Share</td><td className="py-3 px-4 text-right tabular-nums">{fmtUSD(calc.netProfitBeforeShare)}</td></tr>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">Less: Profit Share #1 (5%)</td><td className="py-3 px-4 text-right tabular-nums">({fmtUSD(calc.profitShareEach)})</td></tr>
                    <tr className="border-b border-border"><td className="py-3 px-4 text-muted-foreground">Less: Profit Share #2 (5%)</td><td className="py-3 px-4 text-right tabular-nums">({fmtUSD(calc.profitShareEach)})</td></tr>
                    <tr className="bg-gradient-hero text-primary-foreground font-bold"><td className="py-4 px-4">Final HTL Net Profit</td><td className="py-4 px-4 text-right tabular-nums text-accent">{fmtUSD(calc.finalHtlNet)}</td></tr>
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}

        <footer className="text-center text-xs text-muted-foreground py-8">
          Hometown Lending · LO Recruiting Pro Forma · All figures are illustrative and stored locally in your browser.
        </footer>
      </main>
    </div>
  );
};

export default Index;
