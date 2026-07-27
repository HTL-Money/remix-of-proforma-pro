// Part M (revised): zero-friction self-serve flow — pure-logic coverage.
// Gate BPS conversion, manual-entry fallback flag, self-reported labeling,
// and the suppression check's fail-closed policy.
import { describe, it, expect } from "vitest";
import { bpsToSplit, BPS_MAX } from "@/lib/bps";
import { applyRetrResult } from "@/lib/retrApply";
import { defaultState, calculate } from "@/lib/proforma";
import { buildRecapPayload } from "@/lib/recapEmail";
import { normalizeEmail, suppressionVerdict } from "../../supabase/functions/send-recap/suppression";
import type { RetrParseResult } from "@/lib/retrText";

describe("bpsToSplit (gate BPS entry)", () => {
  it("converts 3-digit BPS to the model's percent form", () => {
    expect(bpsToSplit("200")).toBe(2.0);
    expect(bpsToSplit("125")).toBe(1.25);
  });
  it("empty and whitespace mean 'not provided' → null", () => {
    expect(bpsToSplit("")).toBeNull();
    expect(bpsToSplit("   ")).toBeNull();
  });
  it("invalid and non-positive input → null (never NaN/0 comparisons)", () => {
    expect(bpsToSplit("abc")).toBeNull();
    expect(bpsToSplit("0")).toBeNull();
    expect(bpsToSplit("-50")).toBeNull();
  });
  it(`clamps above ${BPS_MAX} BPS`, () => {
    expect(bpsToSplit("400")).toBe(BPS_MAX / 100);
  });
});

const sampleRetr = (): RetrParseResult => ({
  recruitName: "Jordan Smith",
  nmls: "123456",
  annualVolume: 12_000_000,
  annualFiles: 30,
  avgLoanAmount: 400_000,
  purchaseCount: 20,
  purchaseVolume: 8_000_000,
  refiCount: 10,
  refiVolume: 4_000_000,
  byLoanType: { fha: 6, va: 3, conv: 18, nonqm: 3 },
  rawText: "",
  warnings: [],
  periodMonths: 12,
});

describe("retrSourced flag (manual-entry fallback gate)", () => {
  it("defaultState starts unsourced — fields unlocked, artifacts self-reported", () => {
    expect(defaultState().retrSourced).toBe(false);
  });
  it("a RETR pull marks the model sourced — fields lock", () => {
    const next = applyRetrResult(defaultState(), sampleRetr());
    expect(next.retrSourced).toBe(true);
    expect(next.annualVolume).toBe(12_000_000);
  });
  it("recap payload carries selfReported=true for manual figures", () => {
    const state = { ...defaultState(), annualVolume: 10_000_000, annualFiles: 25, currentSplit: 2 };
    const payload = buildRecapPayload("Test", state, calculate(state));
    expect(payload.selfReported).toBe(true);
  });
  it("recap payload carries selfReported=false after a RETR pull", () => {
    const state = { ...applyRetrResult(defaultState(), sampleRetr()), currentSplit: 2 };
    const payload = buildRecapPayload("Test", state, calculate(state));
    expect(payload.selfReported).toBe(false);
  });
});

describe("suppression check (CAN-SPAM opt-out enforcement)", () => {
  it("normalizes case and whitespace — opt-outs match however the address is typed", () => {
    expect(normalizeEmail("  LO@Example.COM ")).toBe("lo@example.com");
  });
  it("a listed address is suppressed", () => {
    expect(suppressionVerdict({ ok: true, rows: [{ email: "lo@example.com" }] })).toBe("suppressed");
  });
  it("an unlisted address may be sent to", () => {
    expect(suppressionVerdict({ ok: true, rows: [] })).toBe("send");
  });
  it("FAILS CLOSED: lookup failure never allows the send", () => {
    expect(suppressionVerdict(null)).toBe("unavailable");
    expect(suppressionVerdict({ ok: false, rows: null })).toBe("unavailable");
    expect(suppressionVerdict({ ok: true, rows: "not-an-array" })).toBe("unavailable");
  });
});
