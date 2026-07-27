import { describe, it, expect } from "vitest";
import { decideSourcingAction, expiryTimestamp } from "../../supabase/functions/send-recap/sourcing";

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

  it("treats the exact expiry instant as still-valid (strict > , not >=)", () => {
    const row = { nmls: "123456", sourced_by: SENDER_A, expires_at: new Date(NOW).toISOString() };
    expect(decideSourcingAction(row, SENDER_B, NOW)).toEqual({ kind: "reassign", previousSourcedBy: SENDER_A });
  });
});

describe("expiryTimestamp — configurable window", () => {
  it("defaults to roughly 12 months out when given 12", () => {
    const iso = expiryTimestamp(NOW, 12);
    const deltaMs = new Date(iso).getTime() - NOW;
    const twelveMonthsMs = 12 * 30 * 24 * 60 * 60 * 1000;
    expect(deltaMs).toBe(twelveMonthsMs);
  });

  it("is configurable — a different month count produces a different window", () => {
    const sixMonths = new Date(expiryTimestamp(NOW, 6)).getTime();
    const twelveMonths = new Date(expiryTimestamp(NOW, 12)).getTime();
    expect(twelveMonths).toBeGreaterThan(sixMonths);
  });
});
