import { describe, it, expect } from "vitest";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState, fmtUSD } from "@/lib/proforma";
import { prepareChartData, renderRecapChartPng } from "@/lib/recapChart";
import type { ModelState } from "@/lib/proforma";

const goldenState = (): ModelState => ({
  ...defaultState(),
  recruitName: "Jane Smith",
  nmls: "123456",
  annualVolume: 30_000_000,
  annualFiles: 100,
  avgLoanAmount: 300_000,
  currentSplit: 2.0, // 200 BPS
});

const payload = (over: Partial<ModelState> = {}) => {
  const s = { ...goldenState(), ...over };
  return buildRecapPayload("Jane — 90%", s, calculate(s));
};

describe("prepareChartData", () => {
  it("builds both panels from the payload numbers", () => {
    const p = payload();
    const d = prepareChartData(p);
    expect(d).not.toBeNull();
    expect(d!.current.title).toBe("CURRENT PLATFORM");
    expect(d!.current.subtitle).toBe("200 BPS");
    expect(d!.current.annual).toBe(fmtUSD(p.current.annual!));
    expect(d!.htl.title).toBe("HOMETOWN LENDING");
    expect(d!.htl.annual).toBe(fmtUSD(p.htl.annual));
    expect(d!.htl.subtitle).toContain("90% split");
  });

  it("scales the bars to the larger amount", () => {
    const p = payload();
    const d = prepareChartData(p)!;
    const htlLarger = p.htl.annual >= (p.current.annual ?? 0);
    const [big, small] = htlLarger ? [d.htl, d.current] : [d.current, d.htl];
    expect(big.barFrac).toBe(1);
    expect(small.barFrac).toBeGreaterThanOrEqual(0.02);
    expect(small.barFrac).toBeLessThanOrEqual(1);
  });

  it("returns null when no current comp was entered (nothing to compare)", () => {
    expect(prepareChartData(payload({ currentSplit: null }))).toBeNull();
  });

  it("clamps degenerate numbers instead of producing NaN", () => {
    const p = payload();
    p.current.annual = 0;
    p.current.monthly = 0;
    const d = prepareChartData(p)!;
    expect(d.current.barFrac).toBe(0.02);
    expect(Number.isNaN(d.htl.barFrac)).toBe(false);
    expect(d.current.annual).toBe("$0");
  });
});

describe("renderRecapChartPng", () => {
  // jsdom has no canvas 2D context — the contract is a graceful null (the
  // email falls back to its HTML comparison cells), never a throw.
  it("returns null in a canvas-less environment instead of throwing", () => {
    expect(renderRecapChartPng(payload())).toBeNull();
  });

  it("returns null when there is no comparison, before touching the canvas", () => {
    expect(renderRecapChartPng(payload({ currentSplit: null }))).toBeNull();
  });
});
