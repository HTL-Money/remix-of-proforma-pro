import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeRefCode,
  getOrCreateScenarioId,
  getStoredRefCode,
  storeRefCode,
  buildSnapshot,
} from "@/lib/scenarioSync";
import { calculate, defaultBuckets, defaultState, ModelState } from "@/lib/proforma";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const withCorrespondentActive = (buckets = defaultBuckets()) =>
  buckets.map(b => (b.channel === "Correspondent" ? { ...b, active: true } : b));

const goldenState = (overrides: Partial<ModelState> = {}): ModelState => ({
  ...defaultState(),
  annualVolume: 30_000_000,
  annualFiles: 100,
  loSplit: 90,
  holdbackPct: 10,
  loanTypeMix: { fha: 20, va: 15, conv: 55, nonqm: 10 },
  buckets: defaultBuckets(),
  employees: [],
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

describe("sanitizeRefCode", () => {
  it("passes through a valid lowercase code unchanged", () => {
    expect(sanitizeRefCode("jsmith")).toBe("jsmith");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeRefCode("  jsmith  ")).toBe("jsmith");
  });

  it("lowercases uppercase input", () => {
    expect(sanitizeRefCode("JSmith99")).toBe("jsmith99");
  });

  it("allows digits, hyphens, and underscores after the first character", () => {
    expect(sanitizeRefCode("j-smith_2")).toBe("j-smith_2");
  });

  it("allows a single-character code", () => {
    expect(sanitizeRefCode("a")).toBe("a");
  });

  it("rejects a code with disallowed characters (e.g. spaces, symbols)", () => {
    expect(sanitizeRefCode("j smith")).toBeNull();
    expect(sanitizeRefCode("j.smith")).toBeNull();
    expect(sanitizeRefCode("j@smith")).toBeNull();
  });

  it("rejects a code longer than 32 characters", () => {
    const tooLong = "a".repeat(33);
    expect(sanitizeRefCode(tooLong)).toBeNull();
  });

  it("accepts a code exactly 32 characters long", () => {
    const exactly32 = "a".repeat(32);
    expect(sanitizeRefCode(exactly32)).toBe(exactly32);
  });

  it("rejects an empty string", () => {
    expect(sanitizeRefCode("")).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    expect(sanitizeRefCode("   ")).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(sanitizeRefCode(null)).toBeNull();
    expect(sanitizeRefCode(undefined)).toBeNull();
  });

  it("rejects a code starting with a hyphen", () => {
    expect(sanitizeRefCode("-jsmith")).toBeNull();
  });

  it("rejects a code starting with an underscore", () => {
    expect(sanitizeRefCode("_jsmith")).toBeNull();
  });
});

describe("getOrCreateScenarioId", () => {
  it("returns a UUID-shaped string", () => {
    const id = getOrCreateScenarioId();
    expect(id).toMatch(UUID_RE);
  });

  it("is stable across repeated calls", () => {
    const first = getOrCreateScenarioId();
    const second = getOrCreateScenarioId();
    expect(second).toBe(first);
  });

  it("respects a pre-seeded localStorage value instead of generating a new one", () => {
    const seeded = "11111111-1111-1111-1111-111111111111";
    localStorage.setItem("htl_scenario_id_v1", seeded);
    expect(getOrCreateScenarioId()).toBe(seeded);
  });
});

describe("storeRefCode / getStoredRefCode: first-touch wins", () => {
  it("returns null when nothing has been stored yet", () => {
    expect(getStoredRefCode()).toBeNull();
  });

  it("stores a code when none exists yet", () => {
    storeRefCode("a");
    expect(getStoredRefCode()).toBe("a");
  });

  it("does NOT overwrite an existing stored code with a later one", () => {
    storeRefCode("a");
    storeRefCode("b");
    expect(getStoredRefCode()).toBe("a");
  });
});

describe("buildSnapshot", () => {
  it("carries the right fields for the golden scenario, correspondent inactive", () => {
    const state = goldenState();
    const calc = calculate(state);
    // Sanity check against the known golden totals (proforma.test.ts).
    expect(calc.finalLoNetComp).toBeCloseTo(674_500, 2);

    const snapshot = buildSnapshot(state, calc, false);

    expect(snapshot.finalLoNetComp).toBeCloseTo(674_500, 2);
    expect(snapshot.monthlyLoNet).toBeCloseTo(674_500 / 12, 2);
    expect(snapshot.diffAnnual).toBe(calc.diffAnnual);
    expect(snapshot.diffMonthly).toBe(calc.diffMonthly);
    expect(snapshot.annualVolume).toBe(30_000_000);
    expect(snapshot.annualFiles).toBe(100);
    expect(snapshot.avgLoanAmount).toBe(state.avgLoanAmount);
    expect(snapshot.loSplit).toBe(90);
    expect(snapshot.currentSplit).toBeNull();
    expect(snapshot.holdbackPct).toBe(10);
    expect(snapshot.corrActive).toBe(false);
    expect(snapshot.retrImported).toBe(false);
  });

  it("sets corrActive=true when a correspondent-channel bucket is active", () => {
    const state = goldenState({ buckets: withCorrespondentActive() });
    const calc = calculate(state);
    const snapshot = buildSnapshot(state, calc, false);

    expect(snapshot.corrActive).toBe(true);
    // Golden correspondent-active totals from proforma.test.ts.
    expect(snapshot.finalLoNetComp).toBeCloseTo(817_500, 2);
  });

  it("carries retrImported=true through when passed", () => {
    const state = goldenState();
    const calc = calculate(state);
    const snapshot = buildSnapshot(state, calc, true);

    expect(snapshot.retrImported).toBe(true);
  });

  it("carries a non-null currentSplit and its derived diff fields", () => {
    const state = goldenState({ currentSplit: 25 });
    const calc = calculate(state);
    const snapshot = buildSnapshot(state, calc, false);

    expect(snapshot.currentSplit).toBe(25);
    expect(snapshot.diffAnnual).not.toBeNull();
    expect(snapshot.diffMonthly).not.toBeNull();
    expect(snapshot.diffAnnual).toBe(calc.diffAnnual);
  });
});
