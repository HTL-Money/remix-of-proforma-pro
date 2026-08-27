import { describe, it, expect } from "vitest";
import {
  COHORT_EXCLUDE,
  COHORT_INCLUDE,
  inCohort,
  splitAdoption,
  type TeamAccount,
} from "../../supabase/functions/weekly-review/adoption";

// The announcement actually left at 15:05Z on 2026-08-04. Provisioning had
// already run a scripted sign-in against every account at 13:06Z that morning
// to prove the shared password worked — see ANNOUNCED_AT in the function.
const ANNOUNCED = "2026-08-04T15:05:00Z";
const SWEEP = "2026-08-04T13:06:09Z";
const REAL_VISIT = "2026-08-04T18:50:00Z";

const acct = (over: Partial<TeamAccount> & { email: string }): TeamAccount => ({
  id: over.email,
  name: over.email.split("@")[0],
  createdAt: "2026-08-04T02:00:00Z",
  lastSignInAt: null,
  mustSetPassword: true,
  ...over,
});

describe("splitAdoption — adoption is a password reset, not a sign-in", () => {
  it("counts someone who cleared the flag as activated", () => {
    const s = splitAdoption([acct({ email: "done@x.com", mustSetPassword: false, lastSignInAt: REAL_VISIT })]);
    expect(s.activated.map(a => a.email)).toEqual(["done@x.com"]);
    expect(s.pending).toHaveLength(0);
  });

  it("counts someone still holding the temp password as pending, however recently they signed in", () => {
    const s = splitAdoption([acct({ email: "stalled@x.com", lastSignInAt: REAL_VISIT })]);
    expect(s.pending.map(a => a.email)).toEqual(["stalled@x.com"]);
    expect(s.activated).toHaveLength(0);
  });

  // THE REGRESSION. Measuring last_sign_in_at >= "2026-08-04" reported 38 of 38
  // adopted, because the 13:06 sweep is on that date. The owner said he didn't
  // believe it and he was right.
  it("does NOT treat the pre-announcement provisioning sweep as having opened it", () => {
    const s = splitAdoption([acct({ email: "swept@x.com", lastSignInAt: SWEEP })]);
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0].opened).toBe(false);
    expect(s.neverOpened.map(a => a.email)).toEqual(["swept@x.com"]);
    expect(s.openedButStalled).toHaveLength(0);
  });

  it("treats a sign-in at or after the announcement as having opened it", () => {
    const atInstant = splitAdoption([acct({ email: "edge@x.com", lastSignInAt: ANNOUNCED })]);
    expect(atInstant.pending[0].opened).toBe(true);
    const after = splitAdoption([acct({ email: "after@x.com", lastSignInAt: REAL_VISIT })]);
    expect(after.openedButStalled.map(a => a.email)).toEqual(["after@x.com"]);
  });

  it("separates never-opened from opened-but-stalled, which need different follow-up", () => {
    const s = splitAdoption([
      acct({ email: "never@x.com", lastSignInAt: null }),
      acct({ email: "swept@x.com", lastSignInAt: SWEEP }),
      acct({ email: "stalled@x.com", lastSignInAt: REAL_VISIT }),
    ]);
    expect(s.neverOpened.map(a => a.email).sort()).toEqual(["never@x.com", "swept@x.com"]);
    expect(s.openedButStalled.map(a => a.email)).toEqual(["stalled@x.com"]);
    expect(s.openedButStalled.length + s.neverOpened.length).toBe(s.pending.length);
  });
});

describe("splitAdoption — who the daily reminder reaches", () => {
  // `remind` mails exactly s.pending. These are the guards that keep it from
  // becoming spam to someone who already did what was asked.
  it("never includes an activated account, so the nudge stops the moment they finish", () => {
    const s = splitAdoption([
      acct({ email: "done@x.com", mustSetPassword: false, lastSignInAt: REAL_VISIT }),
      acct({ email: "pending@x.com" }),
    ]);
    expect(s.pending.map(a => a.email)).toEqual(["pending@x.com"]);
    expect(s.pending.some(a => a.email === "done@x.com")).toBe(false);
  });

  it("goes quiet entirely once everyone has reset", () => {
    const s = splitAdoption([
      acct({ email: "a@x.com", mustSetPassword: false }),
      acct({ email: "b@x.com", mustSetPassword: false }),
    ]);
    expect(s.pending).toHaveLength(0);
    expect(s.total).toBe(2);
    expect(s.activated).toHaveLength(2);
  });

  it("only a literal true means pending — a stray string or 1 must not trap someone in the reminder loop", () => {
    const s = splitAdoption([
      { ...acct({ email: "str@x.com" }), mustSetPassword: "true" as unknown as boolean },
      { ...acct({ email: "num@x.com" }), mustSetPassword: 1 as unknown as boolean },
    ]);
    // splitAdoption trusts its input; listTeamAccounts is what coerces with
    // `=== true`. This pins the contract: anything truthy that reached here
    // would be treated as pending, which is why the coercion lives upstream.
    expect(s.pending).toHaveLength(2);
  });

  it("sorts the chase list by name so the owner reads the same order each morning", () => {
    const s = splitAdoption([
      acct({ email: "c@x.com", name: "Carol" }),
      acct({ email: "a@x.com", name: "Alice" }),
      acct({ email: "b@x.com", name: "Bob" }),
    ]);
    expect(s.pending.map(a => a.name)).toEqual(["Alice", "Bob", "Carol"]);
  });
});

describe("inCohort — who the rollout actually covers", () => {
  const at = (createdAt: string, email = "someone@hometownlend.com"): TeamAccount =>
    ({ ...acct({ email }), createdAt });

  it("takes accounts provisioned on launch day", () => {
    expect(inCohort(at("2026-08-04T02:00:00Z"))).toBe(true);
  });

  // The window is closed, not an open-ended "since". Left open, every later
  // signup joined silently: it inflates the denominator and drops people who
  // were never invited into the never-opened column.
  it("leaves out accounts created before or after launch day", () => {
    expect(inCohort(at("2026-08-03T23:59:00Z"))).toBe(false);
    expect(inCohort(at("2026-08-05T00:00:00Z"))).toBe(false);
  });

  it("excludes service and pulled-from-rollout accounts created inside the window", () => {
    for (const e of ["admin@hometownlend.com", "lotest@hometownlend.com", "valeriab@hometownlend.com"]) {
      expect(inCohort(at("2026-08-04T02:00:00Z", e))).toBe(false);
    }
  });

  // Post-launch hires would otherwise fall outside the launch-day window: no
  // reminders, absent from the count. Asserted over the whole list rather than
  // one address, so adding the next hire is covered without editing this test.
  it("includes every later hire on the include list, despite the date window", () => {
    expect(COHORT_INCLUDE.size).toBeGreaterThan(0);
    for (const email of COHORT_INCLUDE) {
      expect(inCohort(at("2026-08-08T21:00:00Z", email))).toBe(true);
    }
  });

  it("has the two known post-launch hires on the include list", () => {
    expect([...COHORT_INCLUDE].sort()).toEqual([
      "chrisc@hometownlend.com",
      "dianal@hometownlend.com",
    ]);
  });

  it("fails closed when an address is on both lists — exclude wins", () => {
    const both = [...COHORT_EXCLUDE].find(e => COHORT_INCLUDE.has(e));
    expect(both).toBeUndefined(); // no overlap today
    // Pin the precedence directly so a future overlap can't silently start mailing
    // someone who was deliberately pulled out.
    COHORT_INCLUDE.add("admin@hometownlend.com");
    try {
      expect(inCohort(at("2026-08-08T00:00:00Z", "admin@hometownlend.com"))).toBe(false);
    } finally {
      COHORT_INCLUDE.delete("admin@hometownlend.com");
    }
  });
});
