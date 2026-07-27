import { describe, expect, it } from "vitest";
import { annualizeLoStats, LoanOfficerStatsDto, RETR_DEFAULT_RANGE, periodLabel, periodLabelTitle } from "@/lib/retrApi";

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

describe("annualizeLoStats — actual-period passthrough (no annualization)", () => {
  it("passes a 12-month window through unscaled, with no warning", () => {
    const r = annualizeLoStats(dto(), 12);
    expect(r.annualVolume).toBe(9_600_000);
    expect(r.annualFiles).toBe(24);
    expect(r.avgLoanAmount).toBe(400_000);
    expect(r.purchaseCount).toBe(18);
    expect(r.refiCount).toBe(6);
    expect(r.byLoanType).toEqual({ fha: 8, va: 4, conv: 12, nonqm: 0 });
    expect(r.warnings).toEqual([]);
    expect(r.periodMonths).toBe(12);
  });

  it("a 6-month window shows the REAL 6-month totals, not ×2", () => {
    const r = annualizeLoStats(dto(), 6);
    expect(r.annualVolume).toBe(9_600_000); // same raw DTO totals as the 12mo case
    expect(r.annualFiles).toBe(24);
    expect(r.byLoanType).toEqual({ fha: 8, va: 4, conv: 12, nonqm: 0 });
    expect(r.periodMonths).toBe(6);
    expect(r.warnings).toEqual([]);
  });

  it("a 3-month window is likewise unscaled", () => {
    const r = annualizeLoStats(dto(), 3);
    expect(r.annualVolume).toBe(9_600_000);
    expect(r.annualFiles).toBe(24);
    expect(r.periodMonths).toBe(3);
  });

  it("a 14-month window is likewise unscaled", () => {
    const r = annualizeLoStats(dto({ loanCount: 28, loanVolume: 14_000_000 }), 14);
    expect(r.annualFiles).toBe(28);
    expect(r.annualVolume).toBe(14_000_000);
    expect(r.periodMonths).toBe(14);
  });

  it("never scales the average loan amount (it's window-invariant by construction)", () => {
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

  it("clamps FHA/VA so counts never exceed the total", () => {
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

  it("defaults to a 12-month window constant", () => {
    expect(RETR_DEFAULT_RANGE).toBe(12);
  });
});

describe("periodLabel / periodLabelTitle", () => {
  it("labels a full year as annual", () => {
    expect(periodLabel(12)).toBe("annual");
    expect(periodLabelTitle(12)).toBe("Annual");
  });

  it("labels sub-year windows as 'previous N months'", () => {
    expect(periodLabel(3)).toBe("previous three months");
    expect(periodLabel(6)).toBe("previous six months");
    expect(periodLabel(1)).toBe("previous one month");
    expect(periodLabelTitle(3)).toBe("Previous Three Months");
  });

  it("labels an odd over-a-year window literally", () => {
    expect(periodLabel(14)).toBe("14 months");
    expect(periodLabelTitle(14)).toBe("14 Months");
  });

  it("labels a clean multi-year window as 'N years'", () => {
    expect(periodLabel(24)).toBe("two years");
    expect(periodLabel(36)).toBe("three years");
    expect(periodLabelTitle(24)).toBe("Two Years");
  });
});
