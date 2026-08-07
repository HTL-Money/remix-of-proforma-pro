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
