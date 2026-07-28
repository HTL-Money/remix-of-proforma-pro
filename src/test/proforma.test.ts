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
  SPLIT_TIERS,
  tierForMonthlyVolume,
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

describe("defaultState: zeroed-out start", () => {
  it("production numbers start at zero / empty; HTL deal terms keep standard-offer defaults", () => {
    const s = defaultState();
    expect(s.annualVolume).toBe(0);
    expect(s.annualFiles).toBe(0);
    expect(s.avgLoanAmount).toBe(0);
    expect(s.currentSplit).toBeNull();
    expect(s.recruitName).toBe("");
    expect(s.nmls).toBe("");
    // Deal terms are the standard HTL offer, not filler data — they stay.
    // (The split is no longer part of state at all: calculate() derives it
    // from volume, so a zeroed state has nothing to assert here.)
    expect(s.loanTypeMix).toEqual({ fha: 20, va: 15, conv: 55, nonqm: 10 });
  });

  it("calculate() on the zeroed default state returns all-zero results without error", () => {
    const calc = calculate(defaultState());
    expect(calc.finalLoNetComp).toBe(0);
    expect(calc.totals.grossRevenue).toBe(0);
    expect(calc.diffAnnual).toBeNull();
    expect(calc.currentPlatformAnnual).toBeNull();
  });
});

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

describe("golden scenario: $30,000,000 / 100 files / mix {fha:20, va:15, conv:55, nonqm:10} / derived split 85 (2.5M/mo band)", () => {
  // Default bucket comp percentages used (from defaultBuckets()):
  //   broker_qm compPct = 2.75, broker_nonqm compPct = 2.75, corr_qm compPct = 3.25, corr_nonqm compPct = 3.25
  //
  // The split is DERIVED: $30M over 12 months = $2.5M/mo → the 85/15 band.
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
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);

    it("derives the 85/15 band from volume", () => {
      expect(calc.loSplitPct).toBe(85);
      expect(calc.splitTier.htlPct).toBe(15);
    });

    it("allocates all QM files (fha+va+conv=90) to broker_qm and remainder (10) to broker_nonqm", () => {
      expect(fileCountOf(calc, "broker_qm")).toBe(90);
      expect(fileCountOf(calc, "broker_nonqm")).toBe(10);
    });

    it("computes broker_qm bucket row exactly", () => {
      // volumePct = 90/100*100 = 90%
      // dollarVolume = 30,000,000 * 0.90 = 27,000,000
      // grossRevenue = 27,000,000 * 0.0275 = 742,500
      // loGrossSplit = 742,500 * 0.85 = 631,125
      // channelFees = 90 * 650 = 58,500
      // loNetBeforeHoldback = 631,125 - 58,500 = 572,625
      const row = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
      expect(row.volumePct).toBeCloseTo(90, 6);
      expect(row.dollarVolume).toBeCloseTo(27_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(742_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(631_125, 2);
      expect(row.channelFees).toBeCloseTo(58_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(572_625, 2);
      expect(row.teamHoldback).toBe(0); // no employees -> nothing to hold back
      expect(row.initialLoCash).toBeCloseTo(572_625, 2);
    });

    it("computes broker_nonqm bucket row exactly", () => {
      // volumePct = 10%
      // dollarVolume = 30,000,000 * 0.10 = 3,000,000
      // grossRevenue = 3,000,000 * 0.0275 = 82,500
      // loGrossSplit = 82,500 * 0.85 = 70,125
      // channelFees = 10 * 950 = 9,500
      // loNetBeforeHoldback = 70,125 - 9,500 = 60,625
      const row = calc.buckets.find(b => b.bucket.key === "broker_nonqm")!;
      expect(row.volumePct).toBeCloseTo(10, 6);
      expect(row.dollarVolume).toBeCloseTo(3_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(82_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(70_125, 2);
      expect(row.channelFees).toBeCloseTo(9_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(60_625, 2);
      expect(row.teamHoldback).toBe(0);
      expect(row.initialLoCash).toBeCloseTo(60_625, 2);
    });

    it("computes totals exactly (no employees, so totals overwrite is a no-op: extraBonusTotal=0)", () => {
      // totals.grossRevenue = 742,500 + 82,500 = 825,000
      // totals.loGrossSplit = 631,125 + 70,125 = 701,250
      // totals.channelFees = 58,500 + 9,500 = 68,000
      // totals.loNetBeforeHoldback = 701,250 - 68,000 - 0(extraBonusTotal) = 633,250
      // totals.teamHoldback = 0 (no employees -> no broker-paid overhead to fund)
      // totals.initialLoCash = 633,250 - 0 = 633,250
      expect(calc.totals.grossRevenue).toBeCloseTo(825_000, 2);
      expect(calc.totals.loGrossSplit).toBeCloseTo(701_250, 2);
      expect(calc.totals.channelFees).toBeCloseTo(68_000, 2);
      expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(633_250, 2);
      expect(calc.totals.teamHoldback).toBe(0);
      expect(calc.totals.initialLoCash).toBeCloseTo(633_250, 2);
      expect(calc.totals.qmFiles).toBe(90);
      expect(calc.totals.nonQmFiles).toBe(10);
    });

    it("computes finalLoNetComp and monthlyLoNet exactly (no employees -> no salaryObligations)", () => {
      // salaryObligations = 0 (no employees)
      // finalLoNetComp = 633,250 - 0 = 633,250
      // monthlyLoNet = 633,250 / 12 = 52,770.833...
      expect(calc.finalLoNetComp).toBeCloseTo(633_250, 2);
      expect(calc.monthlyLoNet).toBeCloseTo(633_250 / 12, 2);
    });
  });

  describe("correspondent ACTIVE", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
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
      // loGrossSplit = 165,000 * 0.85 = 140,250
      // channelFees = 20 * 650 = 13,000
      // loNetBeforeHoldback = 140,250 - 13,000 = 127,250
      const row = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
      expect(row.dollarVolume).toBeCloseTo(6_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(165_000, 2);
      expect(row.loGrossSplit).toBeCloseTo(140_250, 2);
      expect(row.channelFees).toBeCloseTo(13_000, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(127_250, 2);
      expect(row.teamHoldback).toBe(0);
      expect(row.initialLoCash).toBeCloseTo(127_250, 2);
    });

    it("computes corr_qm bucket row exactly", () => {
      // volumePct = 70%
      // dollarVolume = 30,000,000 * 0.70 = 21,000,000
      // grossRevenue = 21,000,000 * 0.0325 = 682,500
      // loGrossSplit = 682,500 * 0.85 = 580,125
      // channelFees = 70 * 250 = 17,500
      // loNetBeforeHoldback = 580,125 - 17,500 = 562,625
      const row = calc.buckets.find(b => b.bucket.key === "corr_qm")!;
      expect(row.dollarVolume).toBeCloseTo(21_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(682_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(580_125, 2);
      expect(row.channelFees).toBeCloseTo(17_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(562_625, 2);
      expect(row.teamHoldback).toBe(0);
      expect(row.initialLoCash).toBeCloseTo(562_625, 2);
    });

    it("computes corr_nonqm bucket row exactly", () => {
      // volumePct = 10%
      // dollarVolume = 30,000,000 * 0.10 = 3,000,000
      // grossRevenue = 3,000,000 * 0.0325 = 97,500
      // loGrossSplit = 97,500 * 0.85 = 82,875
      // channelFees = 10 * 250 = 2,500
      // loNetBeforeHoldback = 82,875 - 2,500 = 80,375
      const row = calc.buckets.find(b => b.bucket.key === "corr_nonqm")!;
      expect(row.dollarVolume).toBeCloseTo(3_000_000, 2);
      expect(row.grossRevenue).toBeCloseTo(97_500, 2);
      expect(row.loGrossSplit).toBeCloseTo(82_875, 2);
      expect(row.channelFees).toBeCloseTo(2_500, 2);
      expect(row.loNetBeforeHoldback).toBeCloseTo(80_375, 2);
      expect(row.teamHoldback).toBe(0);
      expect(row.initialLoCash).toBeCloseTo(80_375, 2);
    });

    it("computes totals exactly", () => {
      // totals.grossRevenue = 165,000 + 682,500 + 97,500 = 945,000
      // totals.loGrossSplit = 140,250 + 580,125 + 82,875 = 803,250
      // totals.channelFees = 13,000 + 17,500 + 2,500 = 33,000
      // totals.loNetBeforeHoldback = 803,250 - 33,000 - 0 = 770,250
      expect(calc.totals.grossRevenue).toBeCloseTo(945_000, 2);
      expect(calc.totals.loGrossSplit).toBeCloseTo(803_250, 2);
      expect(calc.totals.channelFees).toBeCloseTo(33_000, 2);
      expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(770_250, 2);
      expect(calc.totals.teamHoldback).toBe(0);
      expect(calc.totals.initialLoCash).toBeCloseTo(770_250, 2);
      expect(calc.totals.qmFiles).toBe(90); // 20 broker_qm + 70 corr_qm
      expect(calc.totals.nonQmFiles).toBe(10);
    });

    it("computes finalLoNetComp and monthlyLoNet exactly", () => {
      expect(calc.finalLoNetComp).toBeCloseTo(770_250, 2);
      expect(calc.monthlyLoNet).toBeCloseTo(770_250 / 12, 2);
    });
  });
});

describe("calculateBrokerOnly", () => {
  it("returns identical totals to calculate() with correspondent forced inactive, from a correspondent-active starting state", () => {
    const activeState = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
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
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      buckets: withCorrespondentActive(),
    });
    const brokerOnly = calculateBrokerOnly(activeState);
    // Same golden totals as the "correspondent INACTIVE" describe block above.
    expect(brokerOnly.totals.loNetBeforeHoldback).toBeCloseTo(633_250, 2);
    expect(brokerOnly.finalLoNetComp).toBeCloseTo(633_250, 2);
  });
});

describe("current-platform comparison", () => {
  it("computes currentPlatformAnnual/Monthly and diffAnnual/Monthly per the code's formula (golden scenario, currentSplit=25, correspondent inactive, no employees)", () => {
    const s = baseState({
      annualVolume: 30_000_000,
      annualFiles: 100,
      currentSplit: 25,
      loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
    });
    const calc = calculate(s);
    // currentPlatformAnnual = annualVolume * (currentSplit/100) - brokerPaidTotal
    //                       = 30,000,000 * 0.25 - 0 (no employees) = 7,500,000
    // currentPlatformMonthly = 7,500,000 / 12 = 625,000
    // htlAnnual = finalLoNetComp = 633,250 (from golden correspondent-inactive scenario)
    // diffAnnual = htlAnnual - currentPlatformAnnual = 633,250 - 7,500,000 = -6,866,750
    // diffMonthly = htlMonthly - currentPlatformMonthly = 52,770.833... - 625,000 = -572,229.166...
    expect(calc.currentPlatformAnnual).toBeCloseTo(7_500_000, 2);
    expect(calc.currentPlatformMonthly).toBeCloseTo(625_000, 2);
    expect(calc.htlAnnual).toBeCloseTo(633_250, 2);
    expect(calc.diffAnnual).toBeCloseTo(-6_866_750, 2);
    expect(calc.diffMonthly).toBeCloseTo(633_250 / 12 - 625_000, 2);
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
    // finalLoNetComp = loNetBeforeHoldback(633,250, extraBonusTotal=0) - 40,000 = 593,250
    expect(noEmployees.finalLoNetComp).toBeCloseTo(633_250, 2);
    expect(withEmployee.finalLoNetComp).toBeCloseTo(593_250, 2);
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
    expect(withEmployee.finalLoNetComp).toBeCloseTo(633_250, 2);
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
    // finalLoNetComp = loNetBeforeHoldback(633,250 - 30,000 = 603,250) - salaryObligations(0) = 603,250
    expect(calc.finalLoNetComp).toBeCloseTo(603_250, 2);
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
    expect(calc.finalLoNetComp).toBeCloseTo(633_250 - 35_000, 2);
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
    // totals.loNetBeforeHoldback (post-overwrite) = 633,250 - 65,000 = 568,250
    // finalLoNetComp = 568,250 - 40,000 = 528,250
    expect(calc.extraBonusTotal).toBeCloseTo(65_000, 2);
    expect(calc.brokerPaidSalaries).toBeCloseTo(40_000, 2);
    expect(calc.htlPaidSalaries).toBeCloseTo(50_000, 2);
    expect(calc.salaryObligations).toBeCloseTo(40_000, 2);
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(568_250, 2);
    expect(calc.finalLoNetComp).toBeCloseTo(528_250, 2);
    // The recruit-facing trio must foot even with per-file bonuses in play:
    // before - salaryObligations = final (extra bonuses live INSIDE 'before').
    expect(calc.totals.loNetBeforeHoldback - calc.salaryObligations).toBeCloseTo(calc.finalLoNetComp, 6);
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

  // The holdback is no longer a user input. It is derived from the LO's actual
  // broker-paid overhead, so with no employees there is nothing to hold back.
  it("no employees means the derived holdback is zero and take-home equals LO net", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
      })
    );
    expect(calc.totals.teamHoldback).toBe(0);
    expect(calc.requiredHoldbackPct).toBe(0);
    expect(calc.holdbackSurplus).toBe(0);
    expect(calc.totals.initialLoCash).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(633_250, 2);
  });

  it("with broker-paid payroll the holdback collects exactly the obligation — no surplus, no shortfall", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees: [
          { id: "e1", name: "P", role: "Processor", salary: 60_000, salarySource: "Broker",
            qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 0 },
        ],
      })
    );
    const obligation = calc.brokerPaidSalaries + calc.brokerPaidBonuses;
    expect(obligation).toBeCloseTo(60_000, 2);
    expect(calc.totals.teamHoldback).toBeCloseTo(obligation, 2);
    expect(calc.holdbackSurplus).toBeCloseTo(0, 6);
    // The derived rate is exactly the share of LO net that funds the team.
    expect(calc.requiredHoldbackPct).toBeCloseTo((obligation / calc.totals.loNetBeforeHoldback) * 100, 6);
    // The bottom line is untouched by the holdback — payroll is deducted in full.
    expect(calc.finalLoNetComp).toBeCloseTo(calc.totals.loNetBeforeHoldback - obligation, 2);
  });

  it("payroll larger than LO net clamps the holdback but take-home still foots to finalLoNetComp", () => {
    const calc = calculate(
      baseState({
        annualVolume: 2_000_000,
        annualFiles: 8,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees: [
          { id: "e1", name: "P", role: "Processor", salary: 500_000, salarySource: "Broker",
            qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 0 },
        ],
      })
    );
    // Can't hold back more cash than the buckets produced (internal metric).
    expect(calc.totals.teamHoldback).toBeCloseTo(Math.max(0, calc.totals.loNetBeforeHoldback), 2);
    expect(calc.holdbackSurplus).toBeLessThan(0);
    // But the recruit-facing take-home column deducts payroll IN FULL, so its
    // total equals the headline number even when the LO is underwater —
    // the buckets table must never show a rosier bottom line than the hero card.
    expect(calc.totals.initialLoCash).toBeCloseTo(calc.finalLoNetComp, 2);
    expect(calc.finalLoNetComp).toBeCloseTo(calc.totals.loNetBeforeHoldback - calc.salaryObligations, 2);
    expect(calc.finalLoNetComp).toBeLessThan(0);
  });

  it("the derived holdback is allocated pro rata and still sums to the total", () => {
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        buckets: defaultBuckets().map(b => b.channel === "Correspondent" ? { ...b, active: true } : b),
        employees: [
          { id: "e1", name: "P", role: "Processor", salary: 80_000, salarySource: "Broker",
            qmBonus: 0, nonQmBonus: 0, bonusSource: "Broker", extraBonus: 0 },
        ],
      })
    );
    expect(calc.buckets.length).toBeGreaterThan(1);
    const summed = calc.buckets.reduce((n, b) => n + b.teamHoldback, 0);
    expect(summed).toBeCloseTo(calc.totals.teamHoldback, 6);
    calc.buckets.forEach(b => expect(b.teamHoldback).toBeGreaterThanOrEqual(0));
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

  it("holds with employees that have extra bonuses (HTL-paid, so the derived holdback stays 0) [Part 2 spec]", () => {
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
    expect(sumBucketField(calc, "loNetBeforeHoldback")).toBeCloseTo(calc.totals.loNetBeforeHoldback, 2);
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 2);
    expect(sumBucketField(calc, "initialLoCash")).toBeCloseTo(calc.totals.initialLoCash, 2);
  });
});

describe("KNOWN DIVERGENCE: per-bucket holdback clamping vs. aggregate clamping (mixed-sign bucket edge case)", () => {
  // Fixing the invariant (deducting extraBonusCost inside each bucket, then summing) changes WHEN the
  // Math.max(0, loNetBeforeHoldback) clamp fires: per-bucket instead of once on the aggregate. These
  // produce the SAME totals.loNetBeforeHoldback (a pure linear sum, unaffected by clamping) and thus the
  // SAME finalLoNetComp — but a bucket whose post-bonus loNetBeforeHoldback goes negative can
  // never fund a holdback. That clamp survived the switch from a user-chosen percentage to a
  // rate derived from payroll: the negative bucket simply gets a zero share of the pro-rata
  // allocation, and the positive bucket absorbs the whole obligation.
  it("a bucket that goes negative funds none of the holdback; the positive bucket absorbs it all", () => {
    // broker_qm: 90 files, loGrossSplit=631,125 (85%), channelFees=58,500 -> pre-bonus loNetBeforeHoldback=572,625
    // broker_nonqm: 10 files, loGrossSplit=70,125 (85%), channelFees=9,500 -> pre-bonus loNetBeforeHoldback=60,625
    // extraBonus = 6,200/file (single Loan Partner, HTL-paid so it doesn't affect salaryObligations)
    //   broker_qm    extraBonusCost = 90*6,200 = 558,000 -> loNetBeforeHoldback =  14,625 (still POSITIVE)
    //   broker_nonqm extraBonusCost = 10*6,200 =  62,000 -> loNetBeforeHoldback =  -1,375 (NEGATIVE)
    // (6,200 keeps the signs mixed under the derived 85% split — the point of this test.)
    // The Loan Partner's salary is broker-paid here, so there IS an obligation to fund.
    const employees: Employee[] = [
      { id: "1", name: "LP", role: "Loan Partner", salary: 10_000, salarySource: "Broker", qmBonus: 0, nonQmBonus: 0, bonusSource: "HTL", extraBonus: 6200 },
    ];
    const calc = calculate(
      baseState({
        annualVolume: 30_000_000,
        annualFiles: 100,
        loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
        employees,
      })
    );
    const brokerQmRow = calc.buckets.find(b => b.bucket.key === "broker_qm")!;
    const brokerNonqmRow = calc.buckets.find(b => b.bucket.key === "broker_nonqm")!;
    expect(brokerQmRow.loNetBeforeHoldback).toBeCloseTo(14_625, 2); // stays positive
    expect(brokerNonqmRow.loNetBeforeHoldback).toBeCloseTo(-1_375, 2); // goes negative
    expect(brokerNonqmRow.teamHoldback).toBe(0); // clamped at the bucket level

    // totals.loNetBeforeHoldback is a pure linear sum, unaffected by how the holdback is derived.
    expect(calc.totals.loNetBeforeHoldback).toBeCloseTo(13_250, 2);
    // The obligation is the broker-paid salary; the single positive bucket funds all of it.
    expect(calc.brokerPaidSalaries).toBeCloseTo(10_000, 2);
    expect(brokerQmRow.teamHoldback).toBeCloseTo(10_000, 2);
    expect(calc.totals.teamHoldback).toBeCloseTo(10_000, 2);
    expect(calc.holdbackSurplus).toBeCloseTo(0, 6); // derived rate never over- or under-collects
    expect(sumBucketField(calc, "teamHoldback")).toBeCloseTo(calc.totals.teamHoldback, 6); // invariant holds
    expect(calc.finalLoNetComp).toBeCloseTo(3_250, 2); // 13,250 - 10,000 broker-paid salary
    // Take-home follows the FULL obligation (not the clamped holdback), so the
    // negative bucket keeps its own loss and the positive bucket carries the payroll.
    expect(calc.totals.initialLoCash).toBeCloseTo(calc.finalLoNetComp, 2);
  });

});

describe("productionPeriodMonths: period-aware monthly + salary proration", () => {
  // A RETR pull that isn't annualized (Part J) means annualVolume/annualFiles
  // can be a raw partial-year total. calculate() must keep "monthly" and flat
  // employee salaries honest for whatever window that is — this is the fix
  // the code review + user confirmed before annualization was removed.
  const employee = (over: Partial<Employee> = {}): Employee => ({
    id: "e1",
    name: "Processor Pat",
    role: "Processor",
    salary: 40_000,
    salarySource: "Broker",
    qmBonus: 0,
    nonQmBonus: 0,
    bonusSource: "Broker",
    extraBonus: 0,
    ...over,
  });

  it("defaults to 12 months — byte-identical to the pre-Part-J behavior", () => {
    const s = baseState({ annualVolume: 12_000_000, annualFiles: 40, employees: [employee()] });
    expect(s.productionPeriodMonths).toBe(12);
    const calc = calculate(s);
    expect(calc.periodMonths).toBe(12);
    expect(calc.brokerPaidSalaries).toBeCloseTo(40_000, 2); // full annual salary, unprorated
    expect(calc.monthlyLoNet).toBeCloseTo(calc.finalLoNetComp / 12, 6);
  });

  it("a 6-month pull prorates the flat salary to half, not a full year", () => {
    const annual = baseState({ annualVolume: 12_000_000, annualFiles: 40, employees: [employee()], productionPeriodMonths: 12 });
    const sixMo = baseState({ annualVolume: 12_000_000, annualFiles: 40, employees: [employee()], productionPeriodMonths: 6 });
    const calcAnnual = calculate(annual);
    const calcSixMo = calculate(sixMo);
    // Same revenue-side numbers (by construction of this test), half the salary cost.
    expect(calcSixMo.brokerPaidSalaries).toBeCloseTo(calcAnnual.brokerPaidSalaries / 2, 2);
    expect(calcSixMo.totals.loNetBeforeHoldback).toBeCloseTo(calcAnnual.totals.loNetBeforeHoldback, 2);
    // So the 6-month pull's comp is HIGHER (half the salary deducted from the
    // same revenue) — the opposite, correct direction from the un-prorated bug.
    expect(calcSixMo.finalLoNetComp).toBeGreaterThan(calcAnnual.finalLoNetComp);
  });

  it("monthly divides by the actual period, not a hardcoded 12", () => {
    const threeMo = baseState({ annualVolume: 6_000_000, annualFiles: 20, productionPeriodMonths: 3 });
    const calc = calculate(threeMo);
    expect(calc.periodMonths).toBe(3);
    expect(calc.monthlyLoNet).toBeCloseTo(calc.finalLoNetComp / 3, 6);
  });

  it("current-platform monthly comp is also period-aware", () => {
    const s = baseState({ annualVolume: 6_000_000, annualFiles: 20, currentSplit: 2.0, productionPeriodMonths: 6 });
    const calc = calculate(s);
    expect(calc.currentPlatformMonthly).toBeCloseTo(calc.currentPlatformAnnual! / 6, 6);
  });

  it("per-file bonuses need no proration — they already scale with the period's file count", () => {
    const emp = employee({ qmBonus: 150, nonQmBonus: 250, bonusSource: "Broker" });
    const s = baseState({ annualVolume: 6_000_000, annualFiles: 20, employees: [emp], productionPeriodMonths: 6 });
    const calc = calculate(s);
    // qmFiles/nonQmFiles come straight from the period's own allocation — no ×periodFrac applied to bonus cost.
    const expectedBonus = calc.totals.qmFiles * 150 + calc.totals.nonQmFiles * 250;
    expect(calc.brokerPaidBonuses).toBeCloseTo(expectedBonus, 2);
  });

  it("calculateBrokerOnly inherits period-awareness (delegates to calculate)", () => {
    const s = baseState({ annualVolume: 6_000_000, annualFiles: 20, employees: [employee()], productionPeriodMonths: 6 });
    const calc = calculateBrokerOnly(s);
    expect(calc.periodMonths).toBe(6);
    expect(calc.brokerPaidSalaries).toBeCloseTo(20_000, 2); // half of the 40k annual salary
  });
});

describe("HTL LO split tiers", () => {
  it("exposes exactly the three real bands, each summing to 100", () => {
    expect(SPLIT_TIERS.map(t => `${t.loPct}/${t.htlPct}`)).toEqual(["80/20", "85/15", "90/10"]);
    SPLIT_TIERS.forEach(t => expect(t.loPct + t.htlPct).toBe(100));
  });

  it("maps monthly volume to the right band", () => {
    expect(tierForMonthlyVolume(0).loPct).toBe(80);
    expect(tierForMonthlyVolume(1_500_000).loPct).toBe(80);
    expect(tierForMonthlyVolume(2_500_000).loPct).toBe(85);
    expect(tierForMonthlyVolume(3_999_999).loPct).toBe(85);
    expect(tierForMonthlyVolume(10_000_000).loPct).toBe(90);
  });

  it("puts a volume sitting exactly on a boundary in the LOWER band", () => {
    expect(tierForMonthlyVolume(2_000_000).loPct).toBe(80);
    expect(tierForMonthlyVolume(4_000_000).loPct).toBe(85);
  });

  it("$48M/yr — the user's stated 90/10 threshold — lands in the top band just above it", () => {
    expect(tierForMonthlyVolume(48_000_000 / 12).loPct).toBe(85); // exactly $4M/mo = boundary
    expect(tierForMonthlyVolume(48_000_001 / 12).loPct).toBe(90);
  });
});

describe("derived split: calculate() picks the band from volume — no input, no override", () => {
  const at = (annualVolume: number, productionPeriodMonths = 12) =>
    calculate(baseState({ annualVolume, annualFiles: 100, productionPeriodMonths }));

  it("moves 80 → 85 → 90 as annual volume grows", () => {
    expect(at(10_000_000).loSplitPct).toBe(80);  // $833k/mo
    expect(at(30_000_000).loSplitPct).toBe(85);  // $2.5M/mo
    expect(at(60_000_000).loSplitPct).toBe(90);  // $5M/mo
  });

  it("annual boundaries land in the LOWER band ($24M and $48M exactly)", () => {
    expect(at(24_000_000).loSplitPct).toBe(80);  // exactly $2M/mo
    expect(at(24_000_012).loSplitPct).toBe(85);
    expect(at(48_000_000).loSplitPct).toBe(85);  // exactly $4M/mo
    expect(at(48_000_012).loSplitPct).toBe(90);
  });

  it("zero volume sits in the bottom band (nothing to model, nothing to promise)", () => {
    expect(at(0).loSplitPct).toBe(80);
  });

  it("a partial-period pull derives monthly volume from ITS OWN window, not /12", () => {
    // $15M over 6 months is $2.5M/mo → 85. Dividing by a hard 12 would call it
    // $1.25M/mo → 80 and quietly under-offer every partial-period recruit.
    expect(at(15_000_000, 6).loSplitPct).toBe(85);
    // And the same $15M over a full year genuinely IS the 80 band.
    expect(at(15_000_000, 12).loSplitPct).toBe(80);
  });

  it("the derived split is what feeds the gross-split math (single point of consumption)", () => {
    const calc = at(60_000_000);
    // 100 files, mix 20/15/55/10, corr inactive: gross = 60M*0.9*0.0275 + 60M*0.1*0.0275
    // loGrossSplit must be gross * 0.90 (the derived band), not any stored value.
    expect(calc.totals.loGrossSplit).toBeCloseTo(calc.totals.grossRevenue * 0.9, 2);
  });
});

describe("hydrate: legacy saves can't resurrect retired inputs", () => {
  it("strips a stored loSplit/holdbackPct so the derived band wins", async () => {
    const { hydrate } = await import("@/lib/proformaStore");
    // A pro forma saved when the split was a manual 90 chip, at $10M/yr —
    // volume that today derives to the 80/20 band.
    const legacyBlob = {
      ...baseState({ annualVolume: 10_000_000, annualFiles: 40 }),
      loSplit: 90,
      holdbackPct: 20,
    } as unknown;
    const state = hydrate(legacyBlob);
    expect("loSplit" in (state as unknown as Record<string, unknown>)).toBe(false);
    expect("holdbackPct" in (state as unknown as Record<string, unknown>)).toBe(false);
    const calc = calculate(state);
    expect(calc.loSplitPct).toBe(80); // derived from volume, not the stored 90
    expect(state.annualVolume).toBe(10_000_000); // everything else survives
  });
});
