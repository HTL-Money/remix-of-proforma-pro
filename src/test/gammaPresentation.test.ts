import { describe, it, expect } from "vitest";
import { enqueueRecapPresentation, pollRecapPresentationStatus } from "@/lib/gammaPresentation";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";

// The test environment has no VITE_SUPABASE_URL/ANON_KEY set, so
// requireSupabase() throws — these tests confirm both functions degrade
// gracefully in that state, matching the "never blocks the send / never
// breaks the recap page" contract every other best-effort generator in this
// app follows (renderRecapChartPng, buildRecapDocxBase64, and the retired
// higgsfieldVideo wrapper this one replaces).

const samplePayload = () => {
  const s = { ...defaultState(), recruitName: "Jordan Avery", nmls: "555222", annualVolume: 12_000_000, annualFiles: 40, avgLoanAmount: 300_000, currentSplit: 2.0 };
  return buildRecapPayload("Jordan — 90%", s, calculate(s));
};

describe("enqueueRecapPresentation", () => {
  it("never throws, even when Supabase isn't configured", async () => {
    await expect(enqueueRecapPresentation("0123456789abcdef", samplePayload())).resolves.toBeUndefined();
  });
});

describe("pollRecapPresentationStatus", () => {
  it("resolves to status 'unknown' rather than throwing when Supabase isn't configured", async () => {
    const result = await pollRecapPresentationStatus("0123456789abcdef");
    expect(result).toEqual({ status: "unknown" });
  });
});
