import { describe, it, expect } from "vitest";
import { encodeRecap, decodeRecap, buildRecapPageUrl, hashRecap } from "@/lib/recapLink";
import { buildRecapPayload } from "@/lib/recapEmail";
import { calculate, defaultState } from "@/lib/proforma";

const sample = () => {
  const s = {
    ...defaultState(),
    recruitName: "Jordan Avery",
    nmls: "555222",
    annualVolume: 12_000_000,
    annualFiles: 40,
    avgLoanAmount: 300_000,
    currentSplit: 2.0,
  };
  return buildRecapPayload("Jordan — 90%", s, calculate(s));
};

describe("recapLink encode/decode", () => {
  it("round-trips a recap payload exactly", () => {
    const p = sample();
    const decoded = decodeRecap(encodeRecap(p));
    expect(decoded).toEqual(p);
  });

  it("preserves period and unicode in the recruit name", () => {
    const p = { ...sample(), loName: "José O’Brien — Señor", periodMonths: 6 };
    const decoded = decodeRecap(encodeRecap(p));
    expect(decoded?.loName).toBe("José O’Brien — Señor");
    expect(decoded?.periodMonths).toBe(6);
  });

  it("produces a URL-safe token (no +, /, or = padding)", () => {
    const token = encodeRecap(sample());
    expect(token).not.toMatch(/[+/=]/);
  });

  it("builds a /r page URL and strips a trailing slash on the origin", () => {
    const url = buildRecapPageUrl(sample(), "https://app.example.com/");
    expect(url.startsWith("https://app.example.com/r?d=")).toBe(true);
  });

  it("returns null for garbage, empty, or tampered params", () => {
    expect(decodeRecap(null)).toBeNull();
    expect(decodeRecap("")).toBeNull();
    expect(decodeRecap("not-base64-$$$")).toBeNull();
    expect(decodeRecap(encodeRecap(sample()).slice(0, 12))).toBeNull(); // truncated
    // Valid base64url of JSON that isn't a recap shape → rejected.
    const notRecap = encodeRecap({ hello: "world" } as unknown as ReturnType<typeof sample>);
    expect(decodeRecap(notRecap)).toBeNull();
  });
});

describe("hashRecap (Part K video dedupe key)", () => {
  it("is deterministic — the same payload always hashes the same", () => {
    const p = sample();
    expect(hashRecap(p)).toBe(hashRecap({ ...p }));
  });

  it("produces a 16-char lowercase hex key", () => {
    expect(hashRecap(sample())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores savedName/proformaId — same scenario dedupes across different saves", () => {
    const p = sample();
    const savedTwice = { ...p, savedName: "A totally different name", proformaId: "some-other-uuid" };
    expect(hashRecap(savedTwice)).toBe(hashRecap(p));
  });

  it("changes when the numbers actually differ", () => {
    const p = sample();
    const differentVolume = { ...p, volume: p.volume + 1 };
    expect(hashRecap(differentVolume)).not.toBe(hashRecap(p));
  });

  it("changes when the period differs, even with identical dollar totals", () => {
    const p = sample();
    const sixMo = { ...p, periodMonths: 6 };
    expect(hashRecap(sixMo)).not.toBe(hashRecap({ ...p, periodMonths: 12 }));
  });
});
