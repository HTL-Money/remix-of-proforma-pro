import { describe, it, expect } from "vitest";
import {
  calculate,
  calculateBrokerOnly,
  defaultBuckets,
  defaultState,
  ModelState,
  Employee,
  QM_FEE,
  NONQM_FEE,
  CORR_FEE,
} from "@/lib/proforma";

// allocateFiles is not exported; exercise it indirectly through calculate()/calculateBrokerOnly()
// via bucket fileCount, which is populated straight from allocateFiles() each call.

const baseState = (overrides: Partial<ModelState> = {}): ModelState => ({
  ...defaultState(),
  buckets: defaultBuckets(),
  ...overrides,
});

const withCorrespondentActive = (buckets = defaultBuckets()) =>
  buckets.map(b => (b.channel === "Correspondent" ? { ...b, active: true } : b));

const fileCountOf = (calc: ReturnType<typeof calculate>, key: string) =>
  calc.buckets.find(b => b.bucket.key === key)?.bucket.fileCount ?? 0;

const sumBucketField = (
  calc: ReturnType<typeof calculate>,
  field: "loNetBeforeHoldback" | "teamHoldback" | "initialLoCash"
) => calc.buckets.reduce((acc, b) => acc + b[field], 0);

describe("allocateFiles (exercised via calculate())", () => {
  it("routes FHA files to broker_qm always, correspondent inactive", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    // fha=round(100*0.20)=20, va=round(100*0.15)=15, conv=round(100*0.55)=55 -> all land in broker_qm
    // since correspondent is inactive: broker_qm = fha+va+conv = 90
    expect(fileCountOf(calc, "broker_qm")).toBe(90);
  });

  it("routes FHA files to broker_qm always, correspondent active", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const calc = calculate(s);
    // FHA (20) always stays in broker_qm even when correspondent is active
    expect(fileCountOf(calc, "broker_qm")).toBe(20);
    // VA+Conv (15+55=70) route to corr_qm since correspondent is active
    expect(fileCountOf(calc, "corr_qm")).toBe(70);
  });

  it("routes VA+Conv to broker_qm when correspondent is inactive", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    expect(fileCountOf(calc, "corr_qm")).toBe(0);
    expect(fileCountOf(calc, "broker_qm")).toBe(90); // fha + va + conv
  });

  it("routes VA+Conv to corr_qm when correspondent is active", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const calc = calculate(s);
    expect(fileCountOf(calc, "corr_qm")).toBe(70); // va + conv
  });

  it("routes nonqm remainder to broker_nonqm when correspondent nonqm inactive", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    // remainder = 100 - 20 - 15 - 55 = 10
    expect(fileCountOf(calc, "broker_nonqm")).toBe(10);
    expect(fileCountOf(calc, "corr_nonqm")).toBe(0);
  });

  it("routes nonqm remainder to corr_nonqm when correspondent nonqm active", () => {
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const calc = calculate(s);
    expect(fileCountOf(calc, "corr_nonqm")).toBe(10);
    expect(fileCountOf(calc, "broker_nonqm")).toBe(0);
  });

  it("clamps the nonqm remainder to never go negative when fha+va+conv rounds above annualFiles", () => {
    // fha=40, va=40, conv=40 all round to themselves (no rounding drift) and sum to 120 > annualFiles=100.
    // remainder = max(0, 100-40-40-40) = max(0,-20) = 0. nonqm bucket receives 0, never negative.
    const s = baseState({
      annualFiles: 100,
      loanTypeMix: { fha: 40, va: 40, conv: 40, nonqm: 0 },
    });
    const calc = calculate(s);
    expect(fileCountOf(calc, "broker_nonqm")).toBe(0);
    expect(fileCountOf(calc, "corr_nonqm")).toBe(0);
  });

  it("allocated files sum to annualFiles when the mix sums to exactly 100", () => {
    const s = baseState({
      annualFiles: 137,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    const total =
      fileCountOf(calc, "broker_qm") +
      fileCountOf(calc, "broker_nonqm") +
      fileCountOf(calc, "corr_qm") +
      fileCountOf(calc, "corr_nonqm");
    expect(total).toBe(137);
  });
});

describe("golden scenario: $30,000,000 / 100 files / mix {fha:20, va:15, conv:55, nonqm:10} / loSplit 90 / holdback 10", () => {
  // Default bucket comp percentages used (from defaultBuckets()):
  //   broker_qm compPct = 2.75, broker_nonqm compPct = 2.75, corr_qm compPct = 3.25, corr_nonqm compPct = 3.25
  //
  // Allocation (shared by both variants):
  //   fha  = round(100*0.20) = 20
  //   va   = round(100*0.15) = 15
  //   conv = round(100*0.55) = 55
  //   nonqm = max(0, 100-20-15-55) = 10

  describe("correspondent INACTIVE", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      loSplit: 90,
      holdbackPct: 10,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);

    it("allocates all QM files (fha+va+conv=90) to broker_qm and remainder (10) to broker_nonqm", () => {
      expect(fileCountOf(calc, "broker_qm")).toBe(90);
      expect(fileCountOf(calc, "broker_nonqm")).toBe(10);
    });

    it("computes broker_qm bucket row exactly", () => {
      // volumePct = 90/100*100 = 90%
      // dollarVolume = 30,000,000 * 0.90 = 27,000,000
      // grossRevenue = 27,000,000 * 0.0275 = 742,500
      // loGrossSplit = 742,500 * 0.90 = 668,250
      // channelFees = 90 * 650 = 58,500
      // loNetBeforeHoldback = 668,250 - 58,500 = 609,750
      // teamHoldback = 609,750 * 0.10 = 60,975
      // initialLoCash = 609,750 - 60,975 = 548,775
      const row = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
      expect(row.volumePct).toBeCloseTo(90, 6);
      expect(row.dollarVolume).toBeCloseTo(27_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(742_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(668_250, 2);
      expect(row.channelFees).toBeCloseTo(58_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(609_750, 2);
      expect(row.teamHoldback).toBeCloseTo(60_975, 2);
      expect(row.initialLoCash).toBeCloseTo(548_775, 2);
    });

    it("computes broker_nonqm bucket row exactly", () => {
      // volumePct = 10%
      // dollarVolume = 30,000,000 * 0.10 = 3,000,000
      // grossRevenue = 3,000,000 * 0.0275 = 82,500
      // loGrossSplit = 82,500 * 0.90 = 74,250
      // channelFees = 10 * 950 = 9,500
      // loNetBeforeHoldback = 74,250 - 9,500 = 64,750
      // teamHoldback = 64,750 * 0.10 = 6,475
      // initialLoCash = 64,750 - 6,475 = 58,275
      const row = calc.buckets.find(b => b.bucket.key === "broker_nonqm")!;
      expect(row.volumePct).toBeCloseTo(10, 6);
      expect(row.dollarVolume).toBeCloseTo(3_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(82_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(74_250, 2);
      expect(row.channelFees).toBeCloseTo(9_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(64_750, 2);
      expect(row.teamHoldback).toBeCloseTo(6_475, 2);
      expect(row.initialLoCash).toBeCloseTo(58_275, 2);
    });

    it("computes totals exactly (no employees, so totals overwrite is a no-op: extraBonusTotal=0)", () => {
      // totals.grossRevenue = 742,500 + 82,500 = 825,000
      // totals.loGrossSplit = 668,250 + 74,250 = 742,500
      // totals.channelFees = 58,500 + 9,500 = 68,000
      // totals.loNetBeforeHoldback = 742,500 - 68,000 - 0(extraBonusTotal) = 674,500
      // totals.teamHoldback = 674,500 * 0.10 = 67,450
      // totals.initialLoCash = 674,500 - 67,450 = 607,050
      expect(calc.totals.grossRevenue).toBeCloseTo(825_000, 2);
      expect(calc.totals.loGrossSplit).toBeCloseTo(742_500, 2);
      expect(calc.totals.channelFees).toBeCloseTo(68_000, 2);
      expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(674_500, 2);
      expect(calc.totals.teamHoldback).toBeCloseTo(67_450, 2);
      expect(calc.totals.initialLoCash).toBeCloseTo(607_050, 2);
      expect(calc.totals.qmFiles).toBe(90);
      expect(calc.totals.nonQmFiles).toBe(10);
    });

    it("computes finalLoNetComp and monthlyLoNet exactly (no employees -> no salaryObligations)", () => {
      // salaryObligations = 0 (no employees)
      // finalLoNetComp = 674,500 - 0 = 674,500
      // monthlyLoNet = 674,500 / 12 = 56,208.333...
      expect(calc.finalLoNetComp).toBeCloseTo(674_500, 2);
      expect(calc.monthlyLoNet).toBeCloseTo(674_500 / 12, 2);
    });
  });

  describe("correspondent ACTIVE", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      loSplit: 90,
      holdbackPct: 10,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const calc = calculate(s);

    it("allocates fha (20) to broker_qm, va+conv (70) to corr_qm, nonqm (10) to corr_nonqm", () => {
      expect(fileCountOf(calc, "broker_qm")).toBe(20);
      expect(fileCountOf(calc, "corr_qm")).toBe(70);
      expect(fileCountOf(calc, "corr_nonqm")).toBe(10);
      expect(fileCountOf(calc, "broker_nonqm")).toBe(0);
    });

    it("computes broker_qm bucket row exactly", () => {
      // volumePct = 20/100*100 = 20%
      // dollarVolume = 30,000,000 * 0.20 = 6,000,000
      // grossRevenue = 6,000,000 * 0.0275 = 165,000
      // loGrossSplit = 165,000 * 0.90 = 148,500
      // channelFees = 20 * 650 = 13,000
      // loNetBeforeHoldback = 148,500 - 13,000 = 135,500
      // teamHoldback = 135,500 * 0.10 = 13,550
      // initialLoCash = 135,500 - 13,550 = 121,950
      const row = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
      expect(row.dollarVolume).toBeCloseTo(6_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(165_000, 2);
      expect(row.loGrossSplit).toBeCloseTo(148_500, 2);
      expect(row.channelFees).toBeCloseTo(13_000, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(135_500, 2);
      expect(row.teamHoldback).toBeCloseTo(13_550, 2);
      expect(row.initialLoCash).toBeCloseTo(121_950, 2);
    });

    it("computes corr_qm bucket row exactly", () => {
      // volumePct = 70%
      // dollarVolume = 30,000,000 * 0.70 = 21,000,000
      // grossRevenue = 21,000,000 * 0.0325 = 682,500
      // loGrossSplit = 682,500 * 0.90 = 614,250
      // channelFees = 70 * 250 = 17,500
      // loNetBeforeHoldback = 614,250 - 17,500 = 596,750
      // teamHoldback = 596,750 * 0.10 = 59,675
      // initialLoCash = 596,750 - 59,675 = 537,075
      const row = calc.buckets.find(b => b.bucket.key === "corr_qm")!;
      expect(row.dollarVolume).toBeCloseTo(21_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(682_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(614_250, 2);
      expect(row.channelFees).toBeCloseTo(17_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(596_750, 2);
      expect(row.teamHoldback).toBeCloseTo(59_675, 2);
      expect(row.initialLoCash).toBeCloseTo(537_075, 2);
    });

    it("computes corr_nonqm bucket row exactly", () => {
      // volumePct = 10%
      // dollarVolume = 30,000,000 * 0.10 = 3,000,000
      // grossRevenue = 3,000,000 * 0.0325 = 97,500
      // loGrossSplit = 97,500 * 0.90 = 87,750
      // channelFees = 10 * 250 = 2,500
      // loNetBeforeHoldback = 87,750 - 2,500 = 85,250
      // teamHoldback = 85,250 * 0.10 = 8,525
      // initialLoCash = 85,250 - 8,525 = 76,725
      const row = calc.buckets.find(b => b.bucket.key === "corr_nonqm")!;
      expect(row.dollarVolume).toBeCloseTo(3_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(97_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(87_750, 2);
      expect(row.channelFees).toBeCloseTo(2_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(85_250, 2);
      expect(row.teamHoldback).toBeCloseTo(8_525, 2);
      expect(row.initialLoCash).toBeCloseTo(76_725, 2);
    });

    it("computes totals exactly", () => {
      // totals.grossRevenue = 165,000 + 682,500 + 97,500 = 945,000
      // totals.loGrossSplit = 148,500 + 614,250 + 87,750 = 850,500
      // totals.channelFees = 13,000 + 17,500 + 2,500 = 33,000
      // totals.loNetBeforeHoldback = 850,500 - 33,000 - 0 = 817,500
      // totals.teamHoldback = 817,500 * 0.10 = 81,750
      // totals.initialLoCash = 817,500 - 81,750 = 735,750
      expect(calc.totals.grossRevenue).toBeCloseTo(945_000, 2);
      expect(calc.totals.loGrossSplit).toBeCloseTo(850_500, 2);
      expect(calc.totals.channelFees).toBeCloseTo(33_000, 2);
      expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(817_500, 2);
      expect(calc.totals.teamHoldback).toBeCloseTo(81_750, 2);
      expect(calc.totals.initialLoCash).toBeCloseTo(735_750, 2);
      expect(calc.totals.qmFiles).toBe(90); // 20 broker_qm + 70 corr_qm
      expect(calc.totals.nonQmFiles).toBe(10);
    });

    it("computes finalLoNetComp and monthlyLoNet exactly", () => {
      expect(calc.finalLoNetComp).toBeCloseTo(817_500, 2);
      expect(calc.monthlyLoNet).toBeCloseTo(817_500 / 12, 2);
    });
  });
});

describe("calculateBrokerOnly", () => {
  it("returns identical totals to calculate() with correspondent forced inactive, from a correspondent-active starting state", () => {
    const activeState = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      loSplit: 90,
      holdbackPct: 10,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const brokerOnly = calculateBrokerOnly(activeState);
    const explicitlyOff = calculate({
      ...activeState,
      buckets: activeState.buckets.map(b => (b.channel === "Correspondent" ? { ...b, active: false } : b)),
    });
    expect(brokerOnly.totals).toEqual(explicitlyOff.totals);
    expect(brokerOnly.finalLoNetComp).toBeCloseTo(explicitlyOff.finalLoNetComp, 6);
  });

  it("matches the golden correspondent-INACTIVE totals when starting from a correspondent-active state", () => {
    const activeState = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      loSplit: 90,
      holdbackPct: 10,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const brokerOnly = calculateBrokerOnly(activeState);
    // Same golden totals as the "correspondent INACTIVE" describe block above.
    expect(brokerOnly.totals.loNetBeforeHoldback).toBeCloseTo(674_500, 2);
    expect(brokerOnly.finalLoNetComp).toBeCloseTo(674_500, 2);
  });
});

describe("current-platform comparison", () => {
  it("computes currentPlatformAnnual/Monthly and diffAnnual/Monthly per the code's formula (golden scenario, currentSplit=25, correspondent inactive, no employees)", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      loSplit: 90,
      holdbackPct: 10,
      currentSplit: 25,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    // currentPlatformAnnual = annualVolume * (currentSplit/100) - brokerPaidTotal
    //                       = 30,000,000 * 0.25 - 0 (no employees) = 7,500,000
    // currentPlatformMonthly = 7,500,000 / 12 = 625,000
    // htlAnnual = finalLoNetComp = 674,500 (from golden correspondent-inactive scenario)
    // diffAnnual = htlAnnual - currentPlatformAnnual = 674,500 - 7,500,000 = -6,825,500
    // diffMonthly = htlMonthly - currentPlatformMonthly = 56,208.333... - 625,000 = -568,791.666...
    expect(calc.currentPlatformAnnual).toBeCloseTo(7_500_000, 2);
    expect(calc.currentPlatformMonthly).toBeCloseTo(625_000, 2);
    expect(calc.htlAnnual).toBeCloseTo(674_500, 2);
    expect(calc.diffAnnual).toBeCloseTo(-6_825_500, 2);
    expect(calc.diffMonthly).toBeCloseTo(674_500 / 12 - 625_000, 2);
  });

  it("returns null for currentPlatform*/diff* fields when currentSplit is null", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      currentSplit: null,
    });
    const calc = calculate(s);
    expect(calc.currentPlatformAnnual).toBeNull();
    expect(calc.currentPlatformMonthly).toBeNull();
    expect(calc.diffAnnual).toBeNull();
    expect(calc.diffMonthly).toBeNull();
  });

  it("subtracts brokerPaidTotal (including extraBonusTotal) from currentPlatformAnnual when employees are present", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 40000, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 300 },
    ];
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      currentSplit: 25,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      employees,
    });
    const calc = calculate(s);
    // brokerPaidSalaries = 40,000 (salarySource=Broker)
    // extraBonusTotal = 300 * 100 files = 30,000
    // brokerPaidTotal = 40,000 + 0(bonuses, role isn't Processor) + 30,000 = 70,000
    // currentPlatformAnnual = 30,000,000*0.25 - 70,000 = 7,430,000
    expect(calc.brokerPaidTotal).toBeCloseTo(70_000, 2);
    expect(calc.currentPlatformAnnual).toBeCloseTo(7_430_000, 2);
  });
});

describe("employees: salaries and extra bonuses reduce final comp", () => {
  it("a broker-paid salary reduces finalLoNetComp by the full salary amount", () => {
    const noEmployees = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    const employees: Employee[] = [
      { id: "1", name: "Proc", role: "Processor", salary: 40000, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 0 },
    ];
    const withEmployee = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    // salary is broker-paid, bonus source is HTL and role IS Processor but qmBonus/nonQmBonus are 0,
    // so brokerPaidBonuses stays 0. salaryObligations = brokerPaidSalaries + brokerPaidBonuses = 40,000.
    // finalLoNetComp = loNetBeforeHoldback(674,500, extraBonusTotal=0) - 40,000 = 634,500
    expect(noEmployees.finalLoNetComp).toBeCloseTo(674_500, 2);
    expect(withEmployee.finalLoNetComp).toBeCloseTo(634_500, 2);
    expect(noEmployees.finalLoNetComp - withEmployee.finalLoNetComp).toBeCloseTo(40_000, 2);
  });

  it("an HTL-paid salary does NOT reduce finalLoNetComp (only broker-paid salaries count as salaryObligations)", () => {
    const employees: Employee[] = [
      { id: "1", name: "Proc", role: "Processor", salary: 40000, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 0 },
    ];
    const withEmployee = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    expect(withEmployee.htlPaidSalaries).toBeCloseTo(40_000, 2);
    expect(withEmployee.brokerPaidSalaries).toBe(0);
    expect(withEmployee.finalLoNetComp).toBeCloseTo(674_500, 2);
  });

  it("Processor per-file qmBonus/nonQmBonus scale with qmFiles/nonQmFiles and only apply to role='Processor'", () => {
    const employees: Employee[] = [
      { id: "1", name: "Proc", role: "Processor", salary: 0, salarySource: "HTL", qmBonus: 150, nonQmBonus: 250, bonusSource: "Broker", extraBonus: 0 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    // qmFiles=90, nonQmFiles=10 (golden, correspondent inactive)
    // bonusCost = 90*150 + 10*250 = 13,500 + 2,500 = 16,000, all broker-paid
    expect(calc.brokerPaidBonuses).toBeCloseTo(16_000, 2);
    expect(calc.htlPaidBonuses).toBe(0);
  });

  it("a non-Processor role's qmBonus/nonQmBonus fields are ignored entirely", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 0, salarySource: "HTL", qmBonus: 999, nonQmBonus: 999, bonusSource: "Broker", extraBonus: 0 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    expect(calc.brokerPaidBonuses).toBe(0);
    expect(calc.htlPaidBonuses).toBe(0);
  });

  it("an LOA's extraBonus (300/file, mirroring LOA_EXTRA_BONUS) feeds extraBonusTotal = extraBonus * totalFiles", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 0, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 300 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    // totalFiles = qmFiles(90) + nonQmFiles(10) = 100
    // extraBonusTotal = 300 * 100 = 30,000
    expect(calc.extraBonusTotal).toBeCloseTo(30_000, 2);
    // extraBonusTotal is NOT part of salaryObligations, but it IS baked into loNetBeforeHoldback via the totals overwrite.
    // finalLoNetComp = loNetBeforeHoldback(674,500 - 30,000 = 644,500) - salaryObligations(0) = 644,500
    expect(calc.finalLoNetComp).toBeCloseTo(644_500, 2);
  });

  it("a Loan Partner's extraBonus (350/file, mirroring LOAN_PARTNER_EXTRA_BONUS) feeds extraBonusTotal identically to an LOA's", () => {
    const employees: Employee[] = [
      { id: "1", name: "LP", role: "Loan Partner", salary: 0, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 350 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    // extraBonusTotal = 350 * 100 = 35,000
    expect(calc.extraBonusTotal).toBeCloseTo(35_000, 2);
    expect(calc.finalLoNetComp).toBeCloseTo(674_500 - 35_000, 2);
  });

  it("multiple employees' extraBonus amounts sum together in extraBonusTotal, and salaries/bonuses combine into salaryObligations", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 40000, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 300 },
      { id: "2", name: "LP", role: "Loan Partner", salary: 50000, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 350 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    // extraBonusTotal = (300 + 350) * 100 files = 65,000
    // brokerPaidSalaries = 40,000 (LOA only; LP is HTL-paid)
    // htlPaidSalaries = 50,000
    // neither employee is a Processor, so brokerPaidBonuses/htlPaidBonuses stay 0
    // salaryObligations = 40,000 + 0 = 40,000
    // totals.loNetBeforeHoldback (post-overwrite) = 674,500 - 65,000 = 609,500
    // finalLoNetComp = 609,500 - 40,000 = 569,500
    expect(calc.extraBonusTotal).toBeCloseTo(65_000, 2);
    expect(calc.brokerPaidSalaries).toBeCloseTo(40_000, 2);
    expect(calc.htlPaidSalaries).toBeCloseTo(50_000, 2);
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(609_500, 2);
    expect(calc.finalLoNetComp).toBeCloseTo(569_500, 2);
  });
});

describe("edge cases", () => {
  it("annualFiles = 0 produces all-zero totals and finalLoNetComp", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 0,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    expect(calc.totals.totalActiveFiles).toBe(0);
    expect(calc.totals.grossRevenue).toBe(0);
    expect(calc.totals.loNetBeforeHoldback).toBe(0);
    expect(calc.finalLoNetComp).toBe(0);
    expect(calc.buckets.length).toBe(0); // activeBuckets filters out fileCount<=0
  });

  it("annualVolume = 0 produces zero revenue but channel fees still accrue per file (net goes negative)", () => {
    const calc = calculate(
      baseState({
        annualVolume: 0,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    // dollarVolume=0 for every bucket -> grossRevenue=0, loGrossSplit=0
    // channelFees = 90*650 + 10*950 = 58,500 + 9,500 = 68,000
    // loNetBeforeHoldback = 0 - 68,000 = -68,000
    // teamHoldback = max(0, -68,000) * 0.10 = 0 (clamped)
    // initialLoCash = -68,000 - 0 = -68,000
    expect(calc.totals.channelFees).toBeCloseTo(68_000, 2);
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(-68_000, 2);
    expect(calc.totals.teamHoldback).toBe(0);
    expect(calc.finalLoNetComp).toBeCloseTo(-68_000, 2);
  });

  it("loanTypeMix summing to LESS than 100 still allocates all annualFiles (remainder formula absorbs the gap)", () => {
    // fha=10, va=10, conv=10 (mix sums to 30+nonqm=30 => 60, not 100)
    // remainder = 100 - 10 - 10 - 10 = 70 -> goes to nonqm bucket regardless of the stated nonqm:30 value
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 10, va: 10, conv: 10, nonqm: 30 },
      })
    );
    expect(fileCountOf(calc, "broker_qm")).toBe(30); // fha+va+conv = 10+10+10
    expect(fileCountOf(calc, "broker_nonqm")).toBe(70); // remainder, NOT the stated 30
    const total =
      fileCountOf(calc, "broker_qm") +
      fileCountOf(calc, "broker_nonqm") +
      fileCountOf(calc, "corr_qm") +
      fileCountOf(calc, "corr_nonqm");
    expect(total).toBe(100);
  });

  it("loanTypeMix summing to MORE than 100 causes allocated files to EXCEED annualFiles (remainder clamp does not claw back overshoot)", () => {
    // fha=40, va=40, conv=40 sum to 120 > annualFiles=100. remainder = max(0, 100-120) = 0.
    // Total allocated = 40+40+40+0 = 120, which EXCEEDS annualFiles. This is a real (documented, not fixed
    // in this phase) characterization of current behavior: the function does not clamp the QM legs themselves.
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 40, va: 40, conv: 40, nonqm: 0 },
      })
    );
    const total =
      fileCountOf(calc, "broker_qm") +
      fileCountOf(calc, "broker_nonqm") +
      fileCountOf(calc, "corr_qm") +
      fileCountOf(calc, "corr_nonqm");
    expect(total).toBe(120);
    expect(total).not.toBe(100);
  });

  it("holdbackPct = 0 means teamHoldback is 0 and initialLoCash equals loNetBeforeHoldback", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        holdbackPct: 0,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    expect(calc.totals.teamHoldback).toBe(0);
    expect(calc.totals.initialLoCash).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(674_500, 2);
  });

  it("holdbackPct = 100 means teamHoldback equals loNetBeforeHoldback and initialLoCash is 0", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        holdbackPct: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    expect(calc.totals.teamHoldback).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(calc.totals.teamHoldback).toBeCloseTo(674_500, 2);
    expect(calc.totals.initialLoCash).toBeCloseTo(0, 2);
  });
});

describe("THE INVARIANT: per-bucket rows must sum to the totals row", () => {
  it("holds with no employees / no extra bonuses (correspondent inactive)", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });

  it("holds with no employees / no extra bonuses (correspondent active)", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        buckets: withCorrespondentActive(),
      })
    );
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });

  // These invariant assertions are the SPEC for Part 2. They FAILED against pre-fix code (see final
  // report for the pre-fix characterization run record, captured while these were `.skip`ped) because
  // the old totals-overwrite block subtracted extraBonusTotal from the totals only, without touching
  // the per-bucket rows. Now that proforma.ts deducts extraBonusCost inside each bucket's
  // loNetBeforeHoldback and totals are a plain column-wise sum of the bucket rows, these pass.
  it("holds with employees that have extra bonuses (single employee, correspondent inactive) [Part 2 spec]", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 0, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 300 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });

  it("holds with employees that have extra bonuses (LOA + Loan Partner, correspondent active) [Part 2 spec]", () => {
    const employees: Employee[] = [
      { id: "1", name: "LOA", role: "Loan Officer Assistant", salary: 40000, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 300 },
      { id: "2", name: "LP", role: "Loan Partner", salary: 50000, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 350 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        buckets: withCorrespondentActive(),
        employees,
      })
    );
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });

  it("holds with employees that have extra bonuses (edge: holdbackPct=0, so no max(0,.) clamp interaction) [Part 2 spec]", () => {
    const employees: Employee[] = [
      { id: "1", name: "LP", role: "Loan Partner", salary: 0, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 350 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        holdbackPct: 0,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });
});

describe("KNOWN DIVERGENCE: per-bucket holdback clamping vs. aggregate clamping (mixed-sign bucket edge case)", () => {
  // Fixing the invariant (deducting extraBonusCost inside each bucket, then summing) changes WHEN the
  // Math.max(0, loNetBeforeHoldback) clamp fires: per-bucket instead of once on the aggregate. These
  // produce the SAME totals.loNetBeforeHoldback (a pure linear sum, unaffected by clamping) and thus the
  // SAME finalLoNetComp — but CAN produce a different totals.teamHoldback (and initialLoCash /
  // holdbackSurplus) whenever one bucket's post-bonus loNetBeforeHoldback goes negative while the
  // aggregate stays positive. This does not occur in any Part 1 golden-scenario configuration (no bucket
  // goes negative there), but is characterized here since it is a real, narrow behavioral change
  // introduced by the Part 2 fix. See final report for the numeric walkthrough.
  it("teamHoldback differs from the pre-fix aggregate-clamp formula when one bucket goes negative and another stays positive", () => {
    // broker_qm: 90 files, loGrossSplit=668,250, channelFees=58,500 -> pre-bonus loNetBeforeHoldback=609,750
    // broker_nonqm: 10 files, loGrossSplit=74,250, channelFees=9,500 -> pre-bonus loNetBeforeHoldback=64,750
    // extraBonus = 6,500/file (single Loan Partner, HTL-paid so it doesn't affect salaryObligations)
    //   broker_qm extraBonusCost = 90*6,500=585,000 -> loNetBeforeHoldback = 609,750-585,000 = 24,750 (still POSITIVE)
    //   broker_nonqm extraBonusCost = 10*6,500=65,000 -> loNetBeforeHoldback = 64,750-65,000 = -250 (NEGATIVE)
    // Post-fix (per-bucket clamp): teamHoldback = max(0,24,750)*10% + max(0,-250)*10% = 2,475 + 0 = 2,475
    // Pre-fix (aggregate clamp):   aggregate loNetBeforeHoldback = 24,750-250 = 24,500 (positive)
    //                              teamHoldback = max(0,24,500)*10% = 2,450
    // 2,475 != 2,450 -- a $25 divergence in this constructed scenario, NOT present in Part 1 golden scenarios.
    const employees: Employee[] = [
      { id: "1", name: "LP", role: "Loan Partner", salary: 0, salarySource: "HTL", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 6500 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loSplit: 90,
        holdbackPct: 10,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    const brokerQmRow = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
    const brokerNonqmRow = calc.buckets.find(b => b.bucket.key === "broker_nonqm")!;
    expect(brokerQmRow.loNetBeforeHoldback).toBeCloseTo(24_750, 2); // stays positive
    expect(brokerNonqmRow.loNetBeforeHoldback).toBeCloseTo(-250, 2); // goes negative
    expect(brokerNonqmRow.teamHoldback).toBe(0); // clamped at the bucket level

    // totals.loNetBeforeHoldback is a pure linear sum -> identical under old and new formulas
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(24_500, 2);
    expect(calc.finalLoNetComp).toBeCloseTo(24_500, 2); // headline number: UNCHANGED by the fix

    // totals.teamHoldback DOES diverge from the old aggregate-clamp formula (2,450) because the fix
    // clamps per-bucket (2,475 = 2,475 + 0), which is the intended, more-correct behavior post-fix.
    expect(calc.totals.teamHoldback).toBeCloseTo(2_475, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2); // invariant still holds
  });
});
