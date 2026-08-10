// Pure adoption classification, split out of index.ts so it can be unit-tested
// without a Deno runtime — same arrangement as send-recap/sourcing.ts.
//
// What "adopted" means here is the whole point of this module. `last_sign_in_at`
// looks like the obvious signal and is the wrong one: anything that
// authenticates stamps it, including the scripted sweep provisioning ran
// against every account to prove the shared password worked. That sweep landed
// two hours before the announcement and made the report claim full uptake.
//
// `must_set_password` can only be cleared by a person choosing their own
// password at the gate, so that is the signal.

export interface TeamAccount {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastSignInAt: string | null;
  /** Still holding the password we generated and emailed them. */
  mustSetPassword: boolean;
}

/** The instant the rollout announcement actually left, not the calendar day it
 *  left on. Provisioning's sign-in sweep ran at 13:06Z the same morning; the
 *  announcement went at 15:05Z. Comparing against the date alone counted all 19
 *  swept accounts as adopted. */
export const ANNOUNCED_AT = "2026-08-04T15:05:00Z";

// ---- Cohort membership -------------------------------------------------------
//
// Lives here rather than in index.ts so the rule is unit-testable: it decides
// who gets mailed and who counts in the denominator, which is exactly the kind
// of logic that shouldn't only be verifiable by sending real email.

/** Launch day. Accounts provisioned in this window are the rollout cohort. */
export const SIGNIN_LAUNCH = "2026-08-04";
/** Exclusive upper bound — a closed window, not an open-ended "since". Without
 *  it every later account joined the cohort silently, inflating the denominator
 *  and putting people who were never invited in the never-visited column. */
export const SIGNIN_LAUNCH_END = "2026-08-05";

/** Never in the cohort, even though they were created in the window.
 *    admin@ / fey@        — legacy service logins
 *    accounting@          — admin-only, deliberately not announced
 *    mikeh@ / adrianag@ /
 *    valeriab@            — pulled from the rollout by the owner
 *    jamesm@ / aryanj@    — predate launch day (excluded by date anyway)
 *    carloss@ / mojia@    — admins; they get the admin invite, not the LO
 *                           announcement, so they'd otherwise receive both
 *    lotest@              — rehearsal account, created inside the window */
export const COHORT_EXCLUDE = new Set([
  "admin@hometownlend.com",
  "fey@hometownlend.com",
  "accounting@hometownlend.com",
  "mikeh@hometownlend.com",
  "adrianag@hometownlend.com",
  "valeriab@hometownlend.com",
  "jamesm@hometownlend.com",
  "aryanj@hometownlend.com",
  "carloss@hometownlend.com",
  "mojia@hometownlend.com",
  "lotest@hometownlend.com",
]);

/** Hires who joined after launch day but belong to the rollout: they get the
 *  reminders and count in adoption exactly like the original cohort. Adding an
 *  address here is how a new LO joins the tracked group — the launch-day window
 *  can't simply grow to cover them without also sweeping in service accounts
 *  and every future non-LO signup. */
export const COHORT_INCLUDE = new Set([
  "dianal@hometownlend.com",
]);

/** Cohort membership for one account. Exclude is checked first on purpose: an
 *  address mistakenly in both lists fails closed (no mail, not counted) rather
 *  than open. */
export const inCohort = (a: TeamAccount): boolean => {
  if (COHORT_EXCLUDE.has(a.email)) return false;
  if (COHORT_INCLUDE.has(a.email)) return true;
  return a.createdAt >= SIGNIN_LAUNCH && a.createdAt < SIGNIN_LAUNCH_END;
};

export interface PendingAccount extends TeamAccount {
  /** Signed in at or after the announcement — a real arrival, not the sweep. */
  opened: boolean;
}

export interface Adoption {
  total: number;
  activated: TeamAccount[];
  pending: PendingAccount[];
  openedButStalled: PendingAccount[];
  neverOpened: PendingAccount[];
}

/** Splits a cohort into people who finished onboarding and people who have not.
 *  The report, the daily reminder, and the weekly review all read this, so none
 *  of them can disagree about who is where. */
export const splitAdoption = (accounts: TeamAccount[]): Adoption => {
  const activated = accounts
    .filter(a => !a.mustSetPassword)
    .sort((a, b) => (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? ""));
  // Sorted by name: this list is read every morning, so a stable order makes
  // yesterday's and today's comparable at a glance.
  const pending: PendingAccount[] = accounts
    .filter(a => a.mustSetPassword)
    .map(a => ({ ...a, opened: !!a.lastSignInAt && a.lastSignInAt >= ANNOUNCED_AT }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    total: accounts.length,
    activated,
    pending,
    // Two different problems: someone who never saw the email, and someone who
    // saw it, showed up, and stopped at the password screen.
    openedButStalled: pending.filter(a => a.opened),
    neverOpened: pending.filter(a => !a.opened),
  };
};
