import { describe, it, expect } from "vitest";
import { buildInputText, hasTeamEconomics, RecapForPrompt } from "../../supabase/functions/gamma-proxy/prompt";

const soloRecap: RecapForPrompt = {
  loName: "Jane Smith",
  current: { annual: 400_000 },
  htl: { annual: 500_000 },
  gain: { annual: 100_000 },
  volume: 20_000_000,
  files: 60,
};

const teamRecap: RecapForPrompt = {
  ...soloRecap,
  totals: {
    loNetBeforeHoldback: 500_000,
    brokerPaidTotal: 120_000,
    finalLoNetComp: 380_000,
  },
};

describe("Gamma deck prompt — team-economics slide", () => {
  it("solo LO (no totals): no team slide, no payroll language, 6-card deck", () => {
    const out = buildInputText(soloRecap);
    expect(out).not.toContain("Team Economics");
    expect(out.toLowerCase()).not.toContain("payroll");
    expect(hasTeamEconomics(soloRecap)).toBe(false);
  });

  it("zero team cost behaves exactly like solo", () => {
    const zeroed: RecapForPrompt = { ...soloRecap, totals: { loNetBeforeHoldback: 500_000, brokerPaidTotal: 0, finalLoNetComp: 500_000 } };
    expect(buildInputText(zeroed)).not.toContain("Team Economics");
    expect(hasTeamEconomics(zeroed)).toBe(false);
  });

  it("LO with a team: slide requested with the exact 3-step waterfall figures", () => {
    const out = buildInputText(teamRecap);
    expect(out).toContain('"Your Team Economics"');
    expect(out).toContain("$500,000"); // LO net before payroll
    expect(out).toContain("$120,000"); // team payroll cost
    expect(out).toContain("$380,000"); // final net comp
    expect(out).toContain("never as a fee, deduction, or penalty");
    expect(hasTeamEconomics(teamRecap)).toBe(true);
  });

  it('NEVER uses the internal word "holdback" in recruit-facing copy — solo or team', () => {
    expect(buildInputText(soloRecap).toLowerCase()).not.toContain("holdback");
    expect(buildInputText(teamRecap).toLowerCase()).not.toContain("holdback");
  });

  it("core deck content survives unchanged for both shapes", () => {
    for (const r of [soloRecap, teamRecap]) {
      const out = buildInputText(r);
      expect(out).toContain("Jane Smith");
      expect(out).toContain("leaving money on the table");
      expect(out).toContain("60 files");
      expect(out).toContain("low-pressure invitation");
    }
  });
});
