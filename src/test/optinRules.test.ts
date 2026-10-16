import { describe, it, expect } from "vitest";
import {
  CONSENT_MONTHS,
  REINVITE_DAYS,
  consentExpiry,
  consentRedirectUrl,
  decideInvite,
  parseBps,
  tokenState,
} from "../../supabase/functions/recruit-optin/rules";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00Z, fixed

describe("consentExpiry — twelve months, date-safe", () => {
  it("lands on the same calendar day a year later", () => {
    expect(CONSENT_MONTHS).toBe(12);
    expect(consentExpiry(NOW)).toBe("2027-10-16T12:00:00.000Z");
  });

  // setMonth(+12) on a leap day rolled to Mar 1 — a consent that silently
  // outlived its twelve months by a day. Clamp to the month's last day instead.
  it("clamps Feb 29 to Feb 28 of the following year, never Mar 1", () => {
    const leap = Date.UTC(2028, 1, 29, 9, 30, 0);
    expect(consentExpiry(leap)).toBe("2029-02-28T09:30:00.000Z");
  });

  it("is independent of the runtime's time zone (UTC in, UTC out)", () => {
    const lateEvening = Date.UTC(2026, 11, 31, 23, 59, 59);
    expect(consentExpiry(lateEvening)).toBe("2027-12-31T23:59:59.000Z");
  });
});

describe("decideInvite — one invite per mailbox per 30 days", () => {
  const prior = (over: Partial<{ invited_at: string; consented_at: string | null; consent_expires_at: string | null }> = {}) => ({
    invited_at: new Date(NOW - 10 * DAY).toISOString(),
    consented_at: null,
    consent_expires_at: null,
    ...over,
  });

  it("allows a first invite", () => {
    expect(decideInvite(null, NOW)).toEqual({ kind: "allow" });
  });

  it("refuses a re-invite inside the window, naming the earlier date", () => {
    const p = prior({ invited_at: new Date(NOW - 29 * DAY).toISOString() });
    expect(decideInvite(p, NOW)).toEqual({ kind: "already_invited", invitedAt: p.invited_at });
  });

  it("allows a re-invite once the window has passed", () => {
    expect(REINVITE_DAYS).toBe(30);
    expect(decideInvite(prior({ invited_at: new Date(NOW - 31 * DAY).toISOString() }), NOW)).toEqual({ kind: "allow" });
  });

  it("lets an admin re-invite inside the window (someone asked on a call)", () => {
    expect(decideInvite(prior(), NOW, { senderIsAdmin: true })).toEqual({ kind: "allow" });
  });

  it("reports a live consent instead of inviting again — the LO can send directly", () => {
    const p = prior({ consented_at: new Date(NOW - DAY).toISOString(), consent_expires_at: new Date(NOW + 300 * DAY).toISOString() });
    expect(decideInvite(p, NOW)).toEqual({ kind: "already_consented" });
    // Even for an admin: there is nothing to re-invite them to.
    expect(decideInvite(p, NOW, { senderIsAdmin: true })).toEqual({ kind: "already_consented" });
  });

  it("treats a lapsed consent like any old invite (window rule applies)", () => {
    const lapsed = prior({
      invited_at: new Date(NOW - 400 * DAY).toISOString(),
      consented_at: new Date(NOW - 399 * DAY).toISOString(),
      consent_expires_at: new Date(NOW - 34 * DAY).toISOString(),
    });
    expect(decideInvite(lapsed, NOW)).toEqual({ kind: "allow" });
  });
});

describe("tokenState — what a consent token currently proves", () => {
  it("unknown for a missing row", () => {
    expect(tokenState(null, NOW)).toBe("unknown");
  });
  it("fresh until the button is pressed", () => {
    expect(tokenState({ consented_at: null, consent_expires_at: null }, NOW)).toBe("fresh");
  });
  it("consented while the twelve months run, lapsed after", () => {
    const at = new Date(NOW - DAY).toISOString();
    expect(tokenState({ consented_at: at, consent_expires_at: new Date(NOW + DAY).toISOString() }, NOW)).toBe("consented");
    expect(tokenState({ consented_at: at, consent_expires_at: new Date(NOW - 1).toISOString() }, NOW)).toBe("lapsed");
    expect(tokenState({ consented_at: at, consent_expires_at: null }, NOW)).toBe("lapsed");
  });
});

describe("parseBps — the optional 'what are they paid today' field", () => {
  it("accepts a sane integer, as number or string", () => {
    expect(parseBps(200)).toBe(200);
    expect(parseBps("200")).toBe(200);
    expect(parseBps(" 125 bps ")).toBe(125);
    expect(parseBps(137.6)).toBe(138);
  });
  it("treats nonsense as absent rather than failing the invite", () => {
    for (const v of [undefined, null, "", "abc", 0, -5, 5000, NaN, {}]) {
      expect(parseBps(v)).toBeNull();
    }
  });
});

describe("consentRedirectUrl — where a confirmed consent lands", () => {
  it("carries ref, nmls and bps", () => {
    expect(consentRedirectUrl("https://htlrecruit.broker", "123456", "0123456789abcdef", 200))
      .toBe("https://htlrecruit.broker/?ref=0123456789abcdef&nmls=123456&bps=200");
  });
  it("omits what it doesn't have, and tolerates a trailing slash on the origin", () => {
    expect(consentRedirectUrl("https://htlrecruit.broker/", "123456", null, null))
      .toBe("https://htlrecruit.broker/?nmls=123456");
  });
});
