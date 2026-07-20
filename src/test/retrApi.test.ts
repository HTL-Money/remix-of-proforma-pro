import { describe, expect, it } from "vitest";
import { annualizeLoStats, LoanOfficerStatsDto, RETR_DEFAULT_RANGE } from "@/lib/retrApi";

const dto = (over: Partial<LoanOfficerStatsDto> = {}): LoanOfficerStatsDto => ({
  firstName: "John",
  lastName: "Doe",
  nmlsId: 123456,
  loanCount: 24,
  loanVolume: 9_600_000,
  purchaseCount: 18,
  refiCount: 6,
  convCount: 12,
  fhaCount: 8,
  vaCount: 4,
  ...over,
});

describe("annualizeLoStats", () => {
  it("passes a 12-month window through unscaled, with no warning", () => {
    const r = annualizeLoStats(dto(), 12);
    expect(r.annualVolume).toBe(9_600_000);
    expect(r.annualFiles).toBe(24);
    expect(r.avgLoanAmount).toBe(400_000);
    expect(r.purchaseCount).toBe(18);
    expect(r.refiCount).toBe(6);
    expect(r.byLoanType).toEqual({ fha: 8, va: 4, conv: 12, nonqm: 0 });
    expect(r.warnings).toEqual([]);
  });

  it("annualizes a 6-month window by ×2 and says so", () => {
    const r = annualizeLoStats(dto(), 6);
    expect(r.annualVolume).toBe(19_200_000);
    expect(r.annualFiles).toBe(48);
    expect(r.purchaseCount).toBe(36);
    expect(r.refiCount).toBe(12);
    expect(r.byLoanType.fha).toBe(16);
    expect(r.byLoanType.va).toBe(8);
    expect(r.byLoanType.conv).toBe(24);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/6-month window.*×2\.00/);
  });

  it("annualizes a 3-month window by ×4", () => {
    const r = annualizeLoStats(dto(), 3);
    expect(r.annualVolume).toBe(38_400_000);
    expect(r.annualFiles).toBe(96);
  });

  it("scales a 14-month window DOWN by 12/14", () => {
    const r = annualizeLoStats(dto({ loanCount: 28, loanVolume: 14_000_000 }), 14);
    expect(r.annualFiles).toBe(24); // 28 * 12/14
    expect(r.annualVolume).toBe(12_000_000);
    expect(r.warnings[0]).toMatch(/14-month window/);
  });

  it("never scales the average loan amount", () => {
    for (const months of [3, 6, 12, 14] as const) {
      expect(annualizeLoStats(dto(), months).avgLoanAmount).toBe(400_000);
    }
  });

  it("rolls the FHA/VA remainder into conv so the mix reconciles to annualFiles", () => {
    // 10 loans but only 2 FHA + 1 VA categorized — 7 land in conv (incl. any
    // jumbo/reverse/other RETR doesn't break out).
    const r = annualizeLoStats(dto({ loanCount: 10, convCount: 3, fhaCount: 2, vaCount: 1 }), 12);
    expect(r.byLoanType.fha + r.byLoanType.va + r.byLoanType.conv + r.byLoanType.nonqm).toBe(r.annualFiles);
    expect(r.byLoanType.conv).toBe(7);
  });

  it("clamps FHA/VA so counts never exceed the annualized total", () => {
    const r = annualizeLoStats(dto({ loanCount: 4, fhaCount: 4, vaCount: 4, convCount: 0 }), 12);
    expect(r.byLoanType.fha).toBe(4);
    expect(r.byLoanType.va).toBe(0);
    expect(r.byLoanType.conv).toBe(0);
    expect(r.byLoanType.fha + r.byLoanType.va + r.byLoanType.conv).toBe(r.annualFiles);
  });

  it("derives purchase/refi volumes from the average loan", () => {
    const r = annualizeLoStats(dto(), 12);
    expect(r.purchaseVolume).toBe(18 * 400_000);
    expect(r.refiVolume).toBe(6 * 400_000);
  });

  it("handles an empty producer without NaN", () => {
    const r = annualizeLoStats(dto({ loanCount: 0, loanVolume: 0, purchaseCount: 0, refiCount: 0, convCount: 0, fhaCount: 0, vaCount: 0 }), 6);
    expect(r.annualVolume).toBe(0);
    expect(r.annualFiles).toBe(0);
    expect(r.avgLoanAmount).toBe(0);
    expect(Number.isNaN(r.avgLoanAmount)).toBe(false);
  });

  it("builds the LO name, tolerating missing parts", () => {
    expect(annualizeLoStats(dto(), 12).recruitName).toBe("John Doe");
    expect(annualizeLoStats(dto({ lastName: null }), 12).recruitName).toBe("John");
    expect(annualizeLoStats(dto({ firstName: null, lastName: null }), 12).recruitName).toBeNull();
  });

  it("defaults to a 6-month window constant", () => {
    expect(RETR_DEFAULT_RANGE).toBe(6);
  });
});
