export type ChannelKey = "broker_qm" | "broker_nonqm" | "corr_qm" | "corr_nonqm";

export interface Bucket {
  key: ChannelKey;
  label: string;
  channel: "Broker" | "Correspondent";
  loanType: "QM" | "Non-QM";
  active: boolean;
  fileCount: number;
  volumePct: number; // derived from fileCount (kept for back-compat / display)
  compPct: number;
  perFileFee: number;
}

export type Role = "Processor" | "Loan Officer Assistant" | "Loan Partner";
export const ROLE_OPTIONS: Role[] = ["Processor", "Loan Officer Assistant", "Loan Partner"];

export type PaySource = "HTL" | "Broker";

export interface Employee {
  id: string;
  name: string;
  role: Role | string;
  salary: number;
  salarySource: PaySource;
  qmBonus: number;     // per-file QM bonus (Processor only)
  nonQmBonus: number;  // per-file Non-QM bonus (Processor only)
  bonusSource: PaySource;
  extraBonus: number;  // per-file extra bonus — broker-paid
}

export interface LoanTypeMix {
  fha: number;
  va: number;
  conv: number;
  nonqm: number;
}

export interface ModelState {
  recruitName: string;
  nmls: string;
  annualVolume: number;
  annualFiles: number;
  avgLoanAmount: number;
  avgLoanOverride: boolean;
  loSplit: number;
  currentSplit: number | null; // stored as percent (BPS / 100)
  loanTypeMix: LoanTypeMix; // sums to 100
  buckets: Bucket[];
  employees: Employee[];
  // Months the production figures above actually cover (RETR pull window).
  // 12 = a true year (the historical assumption everywhere in this file);
  // anything else means annualVolume/annualFiles are a RAW, non-annualized
  // total for that shorter/longer window — calculate() reads this to keep
  // "monthly" and employee-salary proration honest for any period.
  productionPeriodMonths: number;
  // True only when the production figures above came from a real RETR pull.
  // Drives two things: (1) volume/files/mix stay LOCKED read-only in the UI
  // (Part J's data-integrity decision), and (2) anything sent (recap email,
  // Word doc) is labeled RETR-verified. False = the manual-entry fallback is
  // active and every artifact must say "self-reported".
  retrSourced: boolean;
}

// HTL LO split tiers. The band is a function of MONTHLY funded volume — that is
// the real test; the annual figures are just ×12 for readers who think in years.
// "90/10" means the LO keeps 90% of gross commission and HTL keeps 10%.
//
// These are documented on the pro forma (see the "How the HTL LO Split Works"
// section) but deliberately NOT auto-applied: the split chip stays a manual
// choice, so a recruiter can model any band. tierForMonthlyVolume() exists to
// TELL the reader which band their volume falls in, not to pick it for them.
export interface SplitTier {
  loPct: number;
  htlPct: number;
  /** Exclusive lower bound on monthly funded volume. */
  minMonthly: number;
  /** Inclusive upper bound on monthly funded volume; null = no ceiling. */
  maxMonthly: number | null;
}

export const SPLIT_TIERS: SplitTier[] = [
  { loPct: 80, htlPct: 20, minMonthly: 0,       maxMonthly: 2_000_000 },
  { loPct: 85, htlPct: 15, minMonthly: 2_000_000, maxMonthly: 4_000_000 },
  { loPct: 90, htlPct: 10, minMonthly: 4_000_000, maxMonthly: null },
];

/** The tier a given monthly funded volume qualifies for. Boundaries land in the LOWER band. */
export const tierForMonthlyVolume = (monthlyVolume: number): SplitTier =>
  SPLIT_TIERS.find(t => t.maxMonthly == null || monthlyVolume <= t.maxMonthly) ?? SPLIT_TIERS[SPLIT_TIERS.length - 1];

export const BROKER_CAP = 2.75;
export const CORR_MIN = 2.0;
export const CORR_MAX = 8.0;

// Fixed per-file fees
export const QM_FEE = 650;       // Broker QM processing
export const NONQM_FEE = 950;    // Broker Non-QM processing
export const CORR_FEE = 250;     // Correspondent funding fee (QM or Non-QM)

export const defaultBuckets = (): Bucket[] => [
  { key: "broker_qm",    label: "Broker QM",            channel: "Broker",        loanType: "QM",     active: true,  fileCount: 0, volumePct: 0, compPct: 2.75, perFileFee: QM_FEE },
  { key: "broker_nonqm", label: "Broker Non-QM",        channel: "Broker",        loanType: "Non-QM", active: true,  fileCount: 0, volumePct: 0, compPct: 2.75, perFileFee: NONQM_FEE },
  { key: "corr_qm",      label: "Correspondent QM",     channel: "Correspondent", loanType: "QM",     active: false, fileCount: 0, volumePct: 0, compPct: 3.25, perFileFee: CORR_FEE },
  { key: "corr_nonqm",   label: "Correspondent Non-QM", channel: "Correspondent", loanType: "Non-QM", active: false, fileCount: 0, volumePct: 0, compPct: 3.25, perFileFee: CORR_FEE },
];

export const defaultEmployees = (): Employee[] => [];

export const PROCESSOR_DEFAULTS = {
  salary: 40000,
  salarySource: "HTL" as PaySource,
  qmBonus: 150,
  nonQmBonus: 250,
  bonusSource: "HTL" as PaySource,
  extraBonus: 0,
};

// Extra per-file bonus the broker must pay for these support roles
export const LOA_EXTRA_BONUS = 300;
export const LOAN_PARTNER_EXTRA_BONUS = 350;

// One-tap loan-type mixes (percent of files; each sums to 100).
export interface MixPreset {
  key: string;
  label: string;
  mix: LoanTypeMix;
}
export const MIX_PRESETS: MixPreset[] = [
  { key: "balanced", label: "Balanced", mix: { fha: 20, va: 15, conv: 55, nonqm: 10 } },
  { key: "gov", label: "Gov-Heavy", mix: { fha: 35, va: 25, conv: 35, nonqm: 5 } },
  { key: "conv", label: "Conv-Heavy", mix: { fha: 5, va: 5, conv: 85, nonqm: 5 } },
  { key: "nonqm", label: "Non-QM", mix: { fha: 10, va: 5, conv: 45, nonqm: 40 } },
];

// Production numbers start zeroed — every figure on screen should be the
// recruit's real data, never filler. HTL deal terms (split/mix) keep their
// standard-offer defaults so the flow stays one-tap.
export const defaultState = (): ModelState => ({
  recruitName: "",
  nmls: "",
  annualVolume: 0,
  annualFiles: 0,
  avgLoanAmount: 0,
  avgLoanOverride: false,
  loSplit: 90,
  currentSplit: null, // BPS field starts empty
  loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
  buckets: defaultBuckets(),
  employees: defaultEmployees(),
  productionPeriodMonths: 12,
  retrSourced: false,
});

export interface BucketCalc {
  bucket: Bucket;
  volumePct: number;
  dollarVolume: number;
  avgLoan: number;
  grossRevenue: number;
  loGrossSplit: number;
  channelFees: number;
  extraBonusCost: number;
  loNetBeforeHoldback: number;
  teamHoldback: number;
  initialLoCash: number;
}

export interface Calc {
  buckets: BucketCalc[];
  totals: {
    grossRevenue: number;
    loGrossSplit: number;
    channelFees: number;
    extraBonusCost: number;
    loNetBeforeHoldback: number;
    teamHoldback: number;
    initialLoCash: number;
    qmFiles: number;
    nonQmFiles: number;
    totalActiveFiles: number;
  };
  brokerPaidSalaries: number;
  brokerPaidBonuses: number;
  htlPaidSalaries: number;
  htlPaidBonuses: number;
  brokerPaidTotal: number;
  htlPaidTotal: number;
  extraBonusTotal: number;
  holdbackSurplus: number;
  finalLoNetComp: number;
  monthlyLoNet: number;
  requiredHoldbackPct: number;
  currentPlatformAnnual: number | null;
  currentPlatformMonthly: number | null;
  htlAnnual: number;
  htlMonthly: number;
  diffAnnual: number | null;
  diffMonthly: number | null;
  // Echoes ModelState.productionPeriodMonths so consumers (recap/template)
  // don't need the source state just to know what period these totals cover.
  periodMonths: number;
}

// Allocate files by loan type, routing to Correspondent when that channel is active.
// - FHA  → always Broker QM (broker cap 2.75%)
// - VA   → Correspondent QM if active, else Broker QM
// - Conv → Correspondent QM if active, else Broker QM
// - Non-QM → Correspondent Non-QM if active, else Broker Non-QM
const allocateFiles = (s: ModelState): Record<ChannelKey, number> => {
  const mix = s.loanTypeMix;
  const N = s.annualFiles;
  const fha   = Math.round(N * (mix.fha   / 100));
  const va    = Math.round(N * (mix.va    / 100));
  const conv  = Math.round(N * (mix.conv  / 100));
  const nonqm = Math.max(0, N - fha - va - conv);

  const byKey = (k: ChannelKey) => s.buckets.find(b => b.key === k);
  const corrQmActive    = !!byKey("corr_qm")?.active;
  const corrNonqmActive = !!byKey("corr_nonqm")?.active;

  const out: Record<ChannelKey, number> = { broker_qm: 0, broker_nonqm: 0, corr_qm: 0, corr_nonqm: 0 };
  out.broker_qm += fha;
  if (corrQmActive) out.corr_qm += va + conv;
  else out.broker_qm += va + conv;
  if (corrNonqmActive) out.corr_nonqm += nonqm;
  else out.broker_nonqm += nonqm;
  return out;
};

export const calculate = (s: ModelState): Calc => {
  // Everything below assumes annualVolume/annualFiles cover a full year
  // (hence the /12 divisors and flat-annual employee salaries). When the
  // production figures instead cover the RETR pull's actual window (no
  // annualization — see retrApi.ts), periodMonths/periodFrac keep "monthly"
  // and salary costs honest for that window instead of silently mismatching
  // a partial-year revenue total against a full year of fixed cost.
  const periodMonths = s.productionPeriodMonths > 0 ? s.productionPeriodMonths : 12;
  const periodFrac = periodMonths / 12;
  const allocation = allocateFiles(s);
  // Force broker buckets always active (FHA + default Non-QM live there). Apply correct per-channel fee.
  const bucketsResolved: Bucket[] = s.buckets.map(b => ({
    ...b,
    active: b.channel === "Broker" ? true : b.active,
    fileCount: allocation[b.key],
    perFileFee: b.channel === "Correspondent" ? CORR_FEE : (b.loanType === "QM" ? QM_FEE : NONQM_FEE),
  }));
  const activeBuckets = bucketsResolved.filter(b => b.active && b.fileCount > 0);
  const totalActiveFiles = activeBuckets.reduce((a, b) => a + b.fileCount, 0);

  // Per-file LOA/LP extra bonus rate, broker-paid, straight out of gross (like channel fees).
  const extraBonusPerFile = s.employees.reduce((sum, e) => sum + (e.extraBonus || 0), 0);

  // Pass 1: everything that doesn't depend on payroll. The holdback used to be
  // a user-chosen percentage applied right here, but it is now DERIVED from the
  // recruit's actual overhead (see pass 2), and overhead isn't known until the
  // employee loop below — hence the split into two passes.
  type PreHoldback = Omit<BucketCalc, "teamHoldback" | "initialLoCash">;
  const preCalcs: PreHoldback[] = activeBuckets.map(b => {
    const volumePct = totalActiveFiles > 0 ? (b.fileCount / totalActiveFiles) * 100 : 0;
    const dollarVolume = s.annualVolume * (volumePct / 100);
    const avgLoan = b.fileCount > 0 ? dollarVolume / b.fileCount : 0;
    const grossRevenue = dollarVolume * (b.compPct / 100);
    const loGrossSplit = grossRevenue * (s.loSplit / 100);
    const channelFees = b.fileCount * b.perFileFee;
    const extraBonusCost = b.fileCount * extraBonusPerFile;
    const loNetBeforeHoldback = loGrossSplit - channelFees - extraBonusCost;
    return { bucket: b, volumePct, dollarVolume, avgLoan, grossRevenue, loGrossSplit, channelFees, extraBonusCost, loNetBeforeHoldback };
  });

  // Payroll first, so the holdback can be derived from it.
  let brokerPaidSalaries = 0, htlPaidSalaries = 0, brokerPaidBonuses = 0, htlPaidBonuses = 0;
  const preQmFiles = preCalcs.reduce((n, c) => n + (c.bucket.loanType === "QM" ? c.bucket.fileCount : 0), 0);
  const preNonQmFiles = preCalcs.reduce((n, c) => n + (c.bucket.loanType === "QM" ? 0 : c.bucket.fileCount), 0);
  s.employees.forEach(e => {
    // e.salary is a flat ANNUAL figure — prorate to the period so a 6-month
    // pull deducts 6 months of salary, not a full year's, against 6 months of
    // revenue. Per-file bonuses need no proration: they already scale with
    // file count, which is already the actual period's count.
    const proratedSalary = e.salary * periodFrac;
    if (e.salarySource === "Broker") brokerPaidSalaries += proratedSalary;
    else htlPaidSalaries += proratedSalary;
    if (e.role === "Processor") {
      const bonusCost = preQmFiles * e.qmBonus + preNonQmFiles * e.nonQmBonus;
      if (e.bonusSource === "Broker") brokerPaidBonuses += bonusCost;
      else htlPaidBonuses += bonusCost;
    }
  });

  // The holdback exists to fund the LO's broker-paid team costs, so the honest
  // rate is exactly the rate that covers them — no surplus, no shortfall. With
  // no employees it is 0 and the concept simply doesn't apply, which is why it
  // is never shown to a recruit who hasn't added anyone.
  const salaryObligations = brokerPaidSalaries + brokerPaidBonuses;
  // Only profitable buckets can fund a holdback (a bucket underwater on fees
  // has no cash to hold back), matching the old Math.max(0, ...) behavior.
  const positivePool = preCalcs.reduce((sum, c) => sum + Math.max(0, c.loNetBeforeHoldback), 0);
  // Can't hold back more than exists. When payroll outruns production the
  // remainder shows up as a negative holdbackSurplus — a genuine shortfall
  // signal worth keeping for the internal view.
  const holdbackTarget = Math.min(salaryObligations, positivePool);

  // Pass 2: spread the holdback across buckets in proportion to what each one
  // actually nets, so per-bucket figures still sum to the total.
  const bucketCalcs: BucketCalc[] = preCalcs.map(c => {
    const share = positivePool > 0 ? Math.max(0, c.loNetBeforeHoldback) / positivePool : 0;
    const teamHoldback = holdbackTarget * share;
    return { ...c, teamHoldback, initialLoCash: c.loNetBeforeHoldback - teamHoldback };
  });

  const totals = bucketCalcs.reduce((acc, c) => {
    acc.grossRevenue += c.grossRevenue;
    acc.loGrossSplit += c.loGrossSplit;
    acc.channelFees += c.channelFees;
    acc.extraBonusCost += c.extraBonusCost;
    acc.loNetBeforeHoldback += c.loNetBeforeHoldback;
    acc.teamHoldback += c.teamHoldback;
    acc.initialLoCash += c.initialLoCash;
    if (c.bucket.loanType === "QM") acc.qmFiles += c.bucket.fileCount;
    else acc.nonQmFiles += c.bucket.fileCount;
    return acc;
  }, { grossRevenue: 0, loGrossSplit: 0, channelFees: 0, extraBonusCost: 0, loNetBeforeHoldback: 0, teamHoldback: 0, initialLoCash: 0, qmFiles: 0, nonQmFiles: 0, totalActiveFiles });

  const extraBonusTotal = totals.extraBonusCost;
  const brokerPaidTotal = brokerPaidSalaries + brokerPaidBonuses + extraBonusTotal;
  const htlPaidTotal = htlPaidSalaries + htlPaidBonuses;

  // Zero by construction now that the rate is derived, EXCEPT when production
  // can't cover payroll at all — then it goes negative by the uncovered amount.
  const holdbackSurplus = totals.teamHoldback - salaryObligations;
  const finalLoNetComp = totals.loNetBeforeHoldback - salaryObligations;
  const monthlyLoNet = finalLoNetComp / periodMonths;
  const requiredHoldbackPct = totals.loNetBeforeHoldback > 0 ? (salaryObligations / totals.loNetBeforeHoldback) * 100 : 0;

  const currentPlatformAnnual = s.currentSplit != null
    ? s.annualVolume * (s.currentSplit / 100) - brokerPaidTotal
    : null;
  const currentPlatformMonthly = currentPlatformAnnual != null ? currentPlatformAnnual / periodMonths : null;
  const htlAnnual = finalLoNetComp;
  const htlMonthly = monthlyLoNet;
  const diffAnnual = currentPlatformAnnual != null ? htlAnnual - currentPlatformAnnual : null;
  const diffMonthly = currentPlatformMonthly != null ? htlMonthly - currentPlatformMonthly : null;

  return {
    buckets: bucketCalcs,
    totals,
    brokerPaidSalaries, brokerPaidBonuses, htlPaidSalaries, htlPaidBonuses,
    brokerPaidTotal, htlPaidTotal, extraBonusTotal,
    holdbackSurplus, finalLoNetComp, monthlyLoNet, requiredHoldbackPct,
    currentPlatformAnnual, currentPlatformMonthly, htlAnnual, htlMonthly, diffAnnual, diffMonthly,
    periodMonths,
  };
};

// Parallel scenario calculator: HTL "broker only" by forcing correspondent buckets off.
export const calculateBrokerOnly = (s: ModelState): Calc => calculate({
  ...s,
  buckets: s.buckets.map(b => b.channel === "Correspondent" ? { ...b, active: false } : b),
});

export const fmtUSD = (n: number, opts: { compact?: boolean } = {}) => {
  if (!isFinite(n)) return "$0";
  if (opts.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
};
export const fmtPct = (n: number, d = 2) => `${(n ?? 0).toFixed(d)}%`;
export const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
