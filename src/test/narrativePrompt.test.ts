import { describe, it, expect } from "vitest";
import {
  BANNED_IN_NARRATIVE,
  SYSTEM_PROMPT,
  buildNarrativePrompt,
  validateNarrative,
  volumeBand,
} from "../../supabase/functions/send-recap/narrativePrompt";

describe("volumeBand — describes the shape of a book, never the number", () => {
  it("bands by volume", () => {
    expect(volumeBand(60_000_000)).toBe("very high volume");
    expect(volumeBand(30_000_000)).toBe("high volume");
    expect(volumeBand(12_000_000)).toBe("solid, established volume");
    expect(volumeBand(4_000_000)).toBe("a developing book");
    expect(volumeBand(0)).toBe("unstated volume");
    expect(volumeBand(undefined)).toBe("unstated volume");
  });

  it("never puts a digit in the band itself", () => {
    for (const v of [0, 1, 9_999_999, 10_000_000, 48_000_000, 90_000_000]) {
      expect(volumeBand(v)).not.toMatch(/\d/);
    }
  });
});

describe("buildNarrativePrompt — facts in, no figures out", () => {
  it("leaks no dollar figure even though it is built from one", () => {
    const p = buildNarrativePrompt({ volume: 37_500_000, files: 94 });
    expect(p).not.toContain("37");
    expect(p).not.toContain("94");
    expect(p).not.toMatch(/\d/);
  });

  it("tells the model which shape of summary follows", () => {
    expect(buildNarrativePrompt({ hasTeam: true })).toContain("payroll");
    expect(buildNarrativePrompt({ hasTeam: false })).toContain("solo");
  });

  it("warns off implying verification when figures were hand-entered", () => {
    expect(buildNarrativePrompt({ selfReported: true })).toContain("independently verified");
    expect(buildNarrativePrompt({ selfReported: false })).toContain("public licensing records");
  });
});

describe("SYSTEM_PROMPT — states the rules the validator enforces", () => {
  it("forbids numbers, promises, and the internal vocabulary", () => {
    expect(SYSTEM_PROMPT).toContain("State NO numbers");
    expect(SYSTEM_PROMPT).toContain("offer of employment");
    expect(SYSTEM_PROMPT).toContain("holdback");
  });

  it("carries the anti-hype instruction the persona panel called for", () => {
    expect(SYSTEM_PROMPT).toContain("reacts badly to hype");
  });
});

// The prompt is guidance; this is the actual gate. A model that ignores the
// brief must not be able to put a comp claim in front of a recruit.
describe("validateNarrative — the enforcement, not the request", () => {
  const good = "You are already producing at a level most desks never reach. What follows is a plain comparison of your current split against ours, on the same production you are doing now.";

  it("accepts a clean paragraph", () => {
    expect(validateNarrative(good)).toBe(good);
  });

  it("rejects any digit — this is how a comp figure would appear", () => {
    expect(validateNarrative("You could earn 80% of gross.")).toBeNull();
    expect(validateNarrative("Your book grew in 2025.")).toBeNull();
  });

  it("rejects a currency or percent sign even with no digits", () => {
    expect(validateNarrative("You are leaving real $ on the table.")).toBeNull();
    expect(validateNarrative("A better % awaits you.")).toBeNull();
  });

  it("rejects every banned word", () => {
    for (const w of BANNED_IN_NARRATIVE) {
      expect(validateNarrative(`This is a ${w} for you.`)).toBeNull();
    }
  });

  it("rejects the internal word holdback regardless of case", () => {
    expect(validateNarrative("There is no Holdback here.")).toBeNull();
    expect(validateNarrative("There is no HOLDBACK here.")).toBeNull();
  });

  it("rejects markdown and HTML, which would land raw in the email", () => {
    expect(validateNarrative("**You already know.** Here is the rest.")).toBeNull();
    expect(validateNarrative("<b>You already know.</b>")).toBeNull();
  });

  it("rejects a runaway response", () => {
    expect(validateNarrative("You already know. ".repeat(60))).toBeNull();
  });

  it("treats empty, blank, null and undefined as simply absent", () => {
    expect(validateNarrative("")).toBeNull();
    expect(validateNarrative("   \n  ")).toBeNull();
    expect(validateNarrative(null)).toBeNull();
    expect(validateNarrative(undefined)).toBeNull();
  });

  it("trims, so surrounding whitespace can't force a blank paragraph into the email", () => {
    expect(validateNarrative(`\n  ${good}  \n`)).toBe(good);
  });
});
