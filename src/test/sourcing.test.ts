import { describe, it, expect } from "vitest";
import { decideSourcingAction, expiryTimestamp, REFERRAL_TOKEN_RE } from "../../supabase/functions/send-recap/sourcing";
import { REFERRAL_TOKEN_RE as CLIENT_RE, buildReferralUrl, CANONICAL_ORIGIN } from "@/lib/referral";

const SENDER_A = "11111111-1111-1111-1111-111111111111";
const SENDER_B = "22222222-2222-2222-2222-222222222222";
const NOW = 1_700_000_000_000; // fixed instant — deterministic, no Date.now()

describe("decideSourcingAction — HTL5 first-sender-wins", () => {
  it("inserts when no row exists yet (the first person to send it wins)", () => {
    expect(decideSourcingAction(null, SENDER_A, NOW)).toEqual({ kind: "insert" });
  });

  it("no-ops when the same sourcer sends again", () => {
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: new Date(NOW + 1000).toISOString() };
    expect(decideSourcingAction(row, SENDER_A, NOW)).toEqual({ kind: "noop" });
  });

  it("protects the original recruiter: a DIFFERENT sender within the expiry window is a no-op, never an overwrite", () => {
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: new Date(NOW + 1000).toISOString() };
    expect(decideSourcingAction(row, SENDER_B, NOW)).toEqual({ kind: "noop" });
  });

  it("allows reassignment once the row has expired, but flags who it's taking it from", () => {
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: new Date(NOW - 1000).toISOString() };
    expect(decideSourcingAction(row, SENDER_B, NOW)).toEqual({ kind: "reassign", previousSourcedBy: SENDER_A });
  });

  it("treats the exact expiry instant as EXPIRED (validity uses strict >, so at expires_at the claim reassigns)", () => {
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: new Date(NOW).toISOString() };
    expect(decideSourcingAction(row, SENDER_B, NOW)).toEqual({ kind: "reassign", previousSourcedBy: SENDER_A });
  });

  it("90-day window: day 89 is protected, day 91 reassigns", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const claimedAt = NOW - 89 * DAY_MS;
    const freshRow = { nmls: "123456", sourced_by: SENDER_A, expires_at: expiryTimestamp(claimedAt, 90) };
    expect(decideSourcingAction(freshRow, SENDER_B, NOW)).toEqual({ kind: "noop" });

    const staleClaimedAt = NOW - 91 * DAY_MS;
    const staleRow = { nmls: "123456", sourced_by: SENDER_A, expires_at: expiryTimestamp(staleClaimedAt, 90) };
    expect(decideSourcingAction(staleRow, SENDER_B, NOW)).toEqual({ kind: "reassign", previousSourcedBy: SENDER_A });
  });

  it("a re-send by the same LO never extends the window (noop, expires_at untouched)", () => {
    // decideSourcingAction returns noop for the incumbent — the caller writes
    // nothing, so expires_at stays whatever the FIRST send set it to.
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: expiryTimestamp(NOW - 1000, 90) };
    expect(decideSourcingAction(row, SENDER_A, NOW)).toEqual({ kind: "noop" });
  });
});

describe("expiryTimestamp — configurable window in DAYS", () => {
  it("is exactly 90 days out when given 90 (the HTL5 default)", () => {
    const iso = expiryTimestamp(NOW, 90);
    const deltaMs = new Date(iso).getTime() - NOW;
    expect(deltaMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("is configurable — a different day count produces a different window", () => {
    const thirty = new Date(expiryTimestamp(NOW, 30)).getTime();
    const ninety = new Date(expiryTimestamp(NOW, 90)).getTime();
    expect(ninety).toBeGreaterThan(thirty);
  });
});

describe("REFERRAL_TOKEN_RE — recruit-PURL token shape", () => {
  it("accepts exactly what referral_links mints: 16 lowercase hex chars", () => {
    expect(REFERRAL_TOKEN_RE.test("0123456789abcdef")).toBe(true);
    expect(REFERRAL_TOKEN_RE.test("ffffffffffffffff")).toBe(true);
  });

  it("rejects everything else — the token is interpolated into a PostgREST filter", () => {
    expect(REFERRAL_TOKEN_RE.test("0123456789ABCDEF")).toBe(false); // uppercase
    expect(REFERRAL_TOKEN_RE.test("0123456789abcde")).toBe(false); // 15 chars
    expect(REFERRAL_TOKEN_RE.test("0123456789abcdef0")).toBe(false); // 17 chars
    expect(REFERRAL_TOKEN_RE.test("0123456789abcdeg")).toBe(false); // non-hex
    expect(REFERRAL_TOKEN_RE.test("aaaaaaaa-bbbb-cc")).toBe(false); // dashes
    expect(REFERRAL_TOKEN_RE.test("")).toBe(false);
    expect(REFERRAL_TOKEN_RE.test("token=eq.x&or=()")).toBe(false); // injection shape
  });

  it("client and server regexes are the same rule — they can never drift apart", () => {
    expect(CLIENT_RE.source).toBe(REFERRAL_TOKEN_RE.source);
  });
});

describe("buildReferralUrl — the PURL an LO hands out", () => {
  it("lands on / with ?ref= so Home forwards it to the calculator", () => {
    expect(buildReferralUrl("https://proforma.hometownlend.com", "0123456789abcdef"))
      .toBe("https://proforma.hometownlend.com/?ref=0123456789abcdef");
  });

  it("tolerates a trailing slash on the origin instead of emitting a double slash", () => {
    expect(buildReferralUrl("https://htlrecruit.broker/", "0123456789abcdef"))
      .toBe("https://htlrecruit.broker/?ref=0123456789abcdef");
  });

  it("defaults the canonical origin to the real domain, never a deployment URL", () => {
    // A PURL is recruit-facing. The app also answers on *.vercel.app, so building
    // one from wherever the LO signed in would put the wrong host in front of a
    // recruit; RecruitLinks passes CANONICAL_ORIGIN for exactly this reason.
    expect(CANONICAL_ORIGIN).toBe("https://htlrecruit.broker");
    expect(CANONICAL_ORIGIN).not.toMatch(/vercel\.app/);
  });
});
