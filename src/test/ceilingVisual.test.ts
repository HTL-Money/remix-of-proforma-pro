import { describe, it, expect } from "vitest";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState, fmtUSD } from "@/lib/proforma";
import { prepareCeilingData, renderCeilingVisualPng } from "@/lib/ceilingVisual";
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
  return buildRecapPayload("Jane", s, calculate(s));
};

describe("prepareCeilingData", () => {
  it("fills every slot of the labeled spec from the payload numbers", () => {
    const p = payload();
    const d = prepareCeilingData(p);
    expect(d).not.toBeNull();
    expect(d!.currentIncome).toBe(fmtUSD(p.current.annual!));
    expect(d!.htlIncome).toBe(fmtUSD(p.htl.annual));
    expect(d!.currentBps).toBe("200 BPS");
    expect(d!.gain).toBe(fmtUSD(p.htl.annual - p.current.annual!));
  });

  it("computes the HTL side as EFFECTIVE BPS — net ÷ volume, like-for-like with the entered BPS", () => {
    const p = payload();
    const d = prepareCeilingData(p)!;
    const expected = Math.round((p.htl.annual / p.volume) * 10_000);
    expect(d.htlBps).toBe(`${expected} BPS`);
  });

  it("mirrors the chart's eligibility: no BPS entered → null → email falls back to text cells", () => {
    expect(prepareCeilingData(payload({ currentSplit: null }))).toBeNull();
  });

  it("guards the effective-BPS division against zero volume", () => {
    const d = prepareCeilingData(payload({ annualVolume: 0, annualFiles: 0 }));
    expect(d).not.toBeNull();
    expect(d!.htlBps).toBe("—");
  });
});

describe("renderCeilingVisualPng", () => {
  it("returns null under jsdom (no canvas 2D / no image pipeline) without throwing", async () => {
    // Same graceful-degradation contract as renderRecapChartPng: a send is
    // never blocked by the visual — the call sites fall back to the chart,
    // then to the HTML cells.
    await expect(renderCeilingVisualPng(payload())).resolves.toBeNull();
  });

  it("returns null (not a rejection) even for an ineligible payload", async () => {
    await expect(renderCeilingVisualPng(payload({ currentSplit: null }))).resolves.toBeNull();
  });
});
