import { describe, it, expect } from "vitest";
import { parseMoney } from "@/lib/money";
import { MIX_PRESETS } from "@/lib/proforma";

describe("parseMoney", () => {
  it("parses plain numbers", () => {
    expect(parseMoney("48000000")).toBe(48_000_000);
    expect(parseMoney("3.5")).toBe(3.5);
  });

  it("parses formatted currency", () => {
    expect(parseMoney("$48,000,000")).toBe(48_000_000);
    expect(parseMoney("$ 1,250,000")).toBe(1_250_000);
  });

  it("parses k / m / mm / b shorthand, case-insensitive", () => {
    expect(parseMoney("48m")).toBe(48_000_000);
    expect(parseMoney("48M")).toBe(48_000_000);
    expect(parseMoney("1.2m")).toBe(1_200_000);
    expect(parseMoney("480k")).toBe(480_000);
    expect(parseMoney("2mm")).toBe(2_000_000);
    expect(parseMoney("1b")).toBe(1_000_000_000);
  });

  it("parses shorthand with $ and spaces", () => {
    expect(parseMoney("$48m")).toBe(48_000_000);
    expect(parseMoney(" 48 m ")).toBe(48_000_000);
  });

  it("returns 0 for empty or junk input", () => {
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("   ")).toBe(0);
    expect(parseMoney("abc")).toBe(0);
  });

  it("salvages digits from mixed junk", () => {
    expect(parseMoney("about 48000000 total")).toBe(48_000_000);
  });
});

describe("MIX_PRESETS", () => {
  it("every preset sums to exactly 100%", () => {
    for (const p of MIX_PRESETS) {
      const sum = p.mix.fha + p.mix.va + p.mix.conv + p.mix.nonqm;
      expect(sum, `${p.label} sums to ${sum}`).toBe(100);
    }
  });

  it("preset keys are unique", () => {
    const keys = MIX_PRESETS.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
