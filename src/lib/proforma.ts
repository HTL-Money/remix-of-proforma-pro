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
  extraBonus: number;  // per-file extra bonus (Processor only) — broker-paid, increases holdback
}

export interface ModelState {
  recruitName: string;
  annualVolume: number;
  annualFiles: number;
  avgLoanAmount: number;
  avgLoanOverride: boolean;
  loSplit: number;
  currentSplit: number | null;
  holdbackPct: number;
  buckets: Bucket[];
  employees: Employee[];
}

export const BROKER_CAP = 2.75;
export const CORR_MIN = 2.0;
export const CORR_MAX = 8.0;

export const PER_FILE_DEFAULTS: Record<ChannelKey, number> = {
  broker_qm: 650,
  broker_nonqm: 950,
  corr_qm: 250,
  corr_nonqm: 250,
};

export const defaultBuckets = (): Bucket[] => [
  { key: "broker_qm", label: "Broker QM", channel: "Broker", loanType: "QM", active: true, fileCount: 0, volumePct: 0, compPct: 2.75, perFileFee: 650 },
  { key: "broker_nonqm", label: "Broker Non-QM", channel: "Broker", loanType: "Non-QM", active: true, fileCount: 0, volumePct: 0, compPct: 2.75, perFileFee: 950 },
  { key: "corr_qm", label: "Correspondent QM", channel: "Correspondent", loanType: "QM", active: true, fileCount: 0, volumePct: 0, compPct: 3.25, perFileFee: 250 },
  { key: "corr_nonqm", label: "Correspondent Non-QM", channel: "Correspondent", loanType: "Non-QM", active: true, fileCount: 0, volumePct: 0, compPct: 3.25, perFileFee: 250 },
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

export const defaultState = (): ModelState => ({
  recruitName: "",
  annualVolume: 0,
  annualFiles: 0,
  avgLoanAmount: 350_000,
  avgLoanOverride: true,
  loSplit: 90,
  currentSplit: null,
  holdbackPct: 10,
  buckets: defaultBuckets(),
  employees: defaultEmployees(),
});

export interface BucketCalc {
  bucket: Bucket;
  volumePct: number;
  dollarVolume: number;
  avgLoan: number;
  grossRevenue: number;
  loGrossSplit: number;
  channelFees: number;
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
}

export const calculate = (s: ModelState): Calc => {
  const activeBuckets = s.buckets.filter(b => b.active);
  const totalActiveFiles = activeBuckets.reduce((a, b) => a + b.fileCount, 0);

  const bucketCalcs: BucketCalc[] = activeBuckets.map(b => {
    const volumePct = totalActiveFiles > 0 ? (b.fileCount / totalActiveFiles) * 100 : 0;
    const dollarVolume = s.annualVolume * (volumePct / 100);
    const avgLoan = b.fileCount > 0 ? dollarVolume / b.fileCount : 0;
    const grossRevenue = dollarVolume * (b.compPct / 100);
    const loGrossSplit = grossRevenue * (s.loSplit / 100);
    const channelFees = b.fileCount * b.perFileFee;
    const loNetBeforeHoldback = loGrossSplit - channelFees;
    const teamHoldback = Math.max(0, loNetBeforeHoldback) * (s.holdbackPct / 100);
    const initialLoCash = loNetBeforeHoldback - teamHoldback;
    return { bucket: b, volumePct, dollarVolume, avgLoan, grossRevenue, loGrossSplit, channelFees, loNetBeforeHoldback, teamHoldback, initialLoCash };
  });

  const totals = bucketCalcs.reduce((acc, c) => {
    acc.grossRevenue += c.grossRevenue;
    acc.loGrossSplit += c.loGrossSplit;
    acc.channelFees += c.channelFees;
    acc.loNetBeforeHoldback += c.loNetBeforeHoldback;
    acc.teamHoldback += c.teamHoldback;
    acc.initialLoCash += c.initialLoCash;
    if (c.bucket.loanType === "QM") acc.qmFiles += c.bucket.fileCount;
    else acc.nonQmFiles += c.bucket.fileCount;
    return acc;
  }, { grossRevenue: 0, loGrossSplit: 0, channelFees: 0, loNetBeforeHoldback: 0, teamHoldback: 0, initialLoCash: 0, qmFiles: 0, nonQmFiles: 0, totalActiveFiles });

  let brokerPaidSalaries = 0, htlPaidSalaries = 0, brokerPaidBonuses = 0, htlPaidBonuses = 0, extraBonusTotal = 0;
  s.employees.forEach(e => {
    if (e.salarySource === "Broker") brokerPaidSalaries += e.salary;
    else htlPaidSalaries += e.salary;
    const isProcessor = e.role === "Processor";
    if (isProcessor) {
      const bonusCost = totals.qmFiles * e.qmBonus + totals.nonQmFiles * e.nonQmBonus;
      if (e.bonusSource === "Broker") brokerPaidBonuses += bonusCost;
      else htlPaidBonuses += bonusCost;
      extraBonusTotal += (e.extraBonus || 0) * (totals.qmFiles + totals.nonQmFiles);
    }
  });
  // extra bonus is always broker-paid (on top); it raises required holdback
  const brokerPaidTotal = brokerPaidSalaries + brokerPaidBonuses + extraBonusTotal;
  const htlPaidTotal = htlPaidSalaries + htlPaidBonuses;

  const holdbackSurplus = totals.teamHoldback - brokerPaidTotal;
  const finalLoNetComp = totals.loNetBeforeHoldback - brokerPaidTotal;
  const monthlyLoNet = finalLoNetComp / 12;
  const requiredHoldbackPct = totals.loNetBeforeHoldback > 0 ? (brokerPaidTotal / totals.loNetBeforeHoldback) * 100 : 0;

  // Current platform: gross split minus the salaries the broker is already paying
  const currentPlatformAnnual = s.currentSplit != null
    ? s.annualVolume * (s.currentSplit / 100) - brokerPaidSalaries
    : null;
  const currentPlatformMonthly = currentPlatformAnnual != null ? currentPlatformAnnual / 12 : null;
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
  };
};

export const fmtUSD = (n: number, opts: { compact?: boolean } = {}) => {
  if (!isFinite(n)) return "$0";
  if (opts.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
};
export const fmtPct = (n: number, d = 2) => `${(n ?? 0).toFixed(d)}%`;
export const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
