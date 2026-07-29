// Pure HTL5 referral-sourcing decision logic — deliberately separated from
// index.ts's I/O (same reason template.ts is separated: zero Deno-specific
// globals, so it's importable and testable under vitest directly).
//
// The actual database reads/writes and the alert email live in index.ts;
// this file only decides WHAT should happen given the current state.

export interface SourcingRow {
  nmls: string;
  sourced_by: string;
  expires_at: string;
}

export type SourcingAction =
  | { kind: "insert" }
  | { kind: "noop" }
  | { kind: "reassign"; previousSourcedBy: string };

/**
 * First-sender-wins, with a configurable expiry. `nowMs` is injected (not
 * `Date.now()`) so this stays deterministic and fully testable.
 */
export const decideSourcingAction = (existing: SourcingRow | null, senderId: string, nowMs: number): SourcingAction => {
  if (!existing) return { kind: "insert" };
  if (existing.sourced_by === senderId) return { kind: "noop" }; // same sourcer sending again
  const stillValid = new Date(existing.expires_at).getTime() > nowMs;
  if (stillValid) return { kind: "noop" }; // protects the original recruiter — no silent overwrite
  return { kind: "reassign", previousSourcedBy: existing.sourced_by }; // expired — allowed, but must be logged/alerted
};

export const expiryTimestamp = (nowMs: number, expiryDays: number): string =>
  new Date(nowMs + expiryDays * 24 * 60 * 60 * 1000).toISOString();
