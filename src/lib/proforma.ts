export type ChannelKey = "broker_qm" | "broker_nonqm" | "corr_qm" | "corr_nonqm";

export interface Bucket {
  key: ChannelKey;
  label: string;
  channel: "Broker" | "Correspondent";
  loanType: "QM" | "Non-QM";
  active: boolean;
  fileCount: number;
  volumePct: number; // 0-100
  compPct: number; // percent
  perFileFee: number;
}

export interface Employee {
  id: string;
  name: string;
  role: string;
  salary: number;
  salarySource: "HTL" | "Broker";
  qmBonus: number;
  nonQmBonus: number;
  bonusSource: "HTL" | "Broker";
}

export interface ModelState {
  recruitName: string;
  scenarioName: string;
  annualVolume: number;
  annualFiles: number;
  avgLoanAmount: number;
  avgLoanOverride: boolean;
  loSplit: number; // %
  currentSplit: number | null; // %
  holdbackPct: 10 | 20 | 30;
  qmPctHelper: number; // %
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
  { key: "broker_qm", label: "Broker QM", channel: "Broker", loanType: "QM", active: true, fileCount: 0, volumePct: 50, compPct: 2.75, perFileFee: 650 },
  { key: "broker_nonqm", label: "Broker Non-QM", channel: "Broker", loanType: "Non-QM", active: true, fileCount: 0, volumePct: 20, compPct: 2.75, perFileFee: 950 },
  { key: "corr_qm", label: "Correspondent QM", channel: "Correspondent", loanType: "QM", active: true, fileCount: 0, volumePct: 20, compPct: 3.25, perFileFee: 250 },
  { key: "corr_nonqm", label: "Correspondent Non-QM", channel: "Correspondent", loanType: "Non-QM", active: true, fileCount: 0, volumePct: 10, compPct: 3.25, perFileFee: 250 },
];

export const defaultEmployees = (): Employee[] => [
  { id: crypto.randomUUID(), name: "", role: "LOA", salary: 0, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker" },
  { id: crypto.randomUUID(), name: "", role: "Loan Partner", salary: 0, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker" },
  { id: crypto.randomUUID(), name: "", role: "Processor", salary: 40000, salarySource: "Broker", qmBonus: 150, nonQmBonus: 200, bonusSource: "Broker" },
];

export const defaultState = (): ModelState => {
  const annualVolume = 100_000_000;
  const annualFiles = 250;
  const buckets = defaultBuckets();
  // distribute files by volumePct
  buckets.forEach(b => { b.fileCount = Math.round(annualFiles * b.volumePct / 100); });
  return {
    recruitName: "",
    scenarioName: "",
    annualVolume,
    annualFiles,
    avgLoanAmount: annualVolume / annualFiles,
    avgLoanOverride: false,
    loSplit: 90,
    currentSplit: null,
    holdbackPct: 20,
    qmPctHelper: 70,
    buckets,
    employees: defaultEmployees(),
  };
};

export interface BucketCalc {
  bucket: Bucket;
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
    htlRetained: number;
    qmFiles: number;
    nonQmFiles: number;
  };
  brokerPaidSalaries: number;
  brokerPaidBonuses: number;
  htlPaidSalaries: number;
  htlPaidBonuses: number;
  brokerPaidTotal: number;
  htlPaidTotal: number;
  holdbackSurplus: number; // positive = surplus
  finalLoNetComp: number;
  monthlyLoNet: number;
  requiredHoldbackPct: number;
  currentPlatformAnnual: number | null;
  currentPlatformMonthly: number | null;
  htlAnnual: number;
  htlMonthly: number;
  diffAnnual: number | null;
  diffMonthly: number | null;
  // internal
  managementSalary: number;
  netProfitBeforeShare: number;
  profitShareEach: number;
  finalHtlNet: number;
}

export const calculate = (s: ModelState): Calc => {
  const activeBuckets = s.buckets.filter(b => b.active);
  const bucketCalcs: BucketCalc[] = activeBuckets.map(b => {
    const dollarVolume = s.annualVolume * (b.volumePct / 100);
    const avgLoan = b.fileCount > 0 ? dollarVolume / b.fileCount : 0;
    const grossRevenue = dollarVolume * (b.compPct / 100);
    const loGrossSplit = grossRevenue * (s.loSplit / 100);
    const channelFees = b.fileCount * b.perFileFee;
    const loNetBeforeHoldback = loGrossSplit - channelFees;
    const teamHoldback = Math.max(0, loNetBeforeHoldback) * (s.holdbackPct / 100);
    const initialLoCash = loNetBeforeHoldback - teamHoldback;
    return { bucket: b, dollarVolume, avgLoan, grossRevenue, loGrossSplit, channelFees, loNetBeforeHoldback, teamHoldback, initialLoCash };
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
  }, { grossRevenue: 0, loGrossSplit: 0, channelFees: 0, loNetBeforeHoldback: 0, teamHoldback: 0, initialLoCash: 0, htlRetained: 0, qmFiles: 0, nonQmFiles: 0 });

  totals.htlRetained = totals.grossRevenue - totals.loGrossSplit;

  let brokerPaidSalaries = 0, htlPaidSalaries = 0, brokerPaidBonuses = 0, htlPaidBonuses = 0;
  s.employees.forEach(e => {
    if (e.salarySource === "Broker") brokerPaidSalaries += e.salary;
    else htlPaidSalaries += e.salary;
    const bonusCost = totals.qmFiles * e.qmBonus + totals.nonQmFiles * e.nonQmBonus;
    if (e.bonusSource === "Broker") brokerPaidBonuses += bonusCost;
    else htlPaidBonuses += bonusCost;
  });
  const brokerPaidTotal = brokerPaidSalaries + brokerPaidBonuses;
  const htlPaidTotal = htlPaidSalaries + htlPaidBonuses;

  const holdbackSurplus = totals.teamHoldback - brokerPaidTotal;
  const finalLoNetComp = totals.loNetBeforeHoldback - brokerPaidTotal;
  const monthlyLoNet = finalLoNetComp / 12;
  const requiredHoldbackPct = totals.loNetBeforeHoldback > 0 ? (brokerPaidTotal / totals.loNetBeforeHoldback) * 100 : 0;

  const currentPlatformAnnual = s.currentSplit != null ? totals.grossRevenue * (s.currentSplit / 100) : null;
  const currentPlatformMonthly = currentPlatformAnnual != null ? currentPlatformAnnual / 12 : null;
  const htlAnnual = finalLoNetComp;
  const htlMonthly = monthlyLoNet;
  const diffAnnual = currentPlatformAnnual != null ? htlAnnual - currentPlatformAnnual : null;
  const diffMonthly = currentPlatformMonthly != null ? htlMonthly - currentPlatformMonthly : null;

  // internal company
  const managementSalary = 60000;
  const netProfitBeforeShare = totals.htlRetained - htlPaidTotal - managementSalary;
  const profitShareEach = Math.max(0, netProfitBeforeShare) * 0.05;
  const finalHtlNet = netProfitBeforeShare - profitShareEach * 2;

  return {
    buckets: bucketCalcs,
    totals,
    brokerPaidSalaries, brokerPaidBonuses, htlPaidSalaries, htlPaidBonuses,
    brokerPaidTotal, htlPaidTotal,
    holdbackSurplus, finalLoNetComp, monthlyLoNet, requiredHoldbackPct,
    currentPlatformAnnual, currentPlatformMonthly, htlAnnual, htlMonthly, diffAnnual, diffMonthly,
    managementSalary, netProfitBeforeShare, profitShareEach, finalHtlNet,
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
