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
  /** Nothing to write: the same sourcer sending again, or an admin overriding
   *  someone else's live claim (credit stays put — never silently reassigned). */
  | { kind: "noop" }
  /** Another LO holds a live claim and the sender is not an admin. The caller
   *  must refuse the send; see the pre-send gate in index.ts. */
  | { kind: "blocked"; claimedBy: string; expiresAt: string }
  | { kind: "reassign"; previousSourcedBy: string };

/**
 * First-sender-wins, with a configurable expiry. `nowMs` is injected (not
 * `Date.now()`) so this stays deterministic and fully testable.
 *
 * A live claim held by someone else now BLOCKS the send rather than quietly
 * proceeding without credit, which is what it used to do — an LO could send to
 * a colleague's claimed recruit and never find out the attribution hadn't moved.
 * Admins are exempt so there is still a way through when a claim holder has
 * left or a recruit genuinely switched LOs.
 *
 * `senderIsAdmin` must be resolved from a VERIFIED identity, never a
 * client-supplied flag — see resolveSenderIsAdmin in index.ts.
 */
export const decideSourcingAction = (
  existing: SourcingRow | null,
  senderId: string,
  nowMs: number,
  opts: { senderIsAdmin?: boolean } = {},
): SourcingAction => {
  if (!existing) return { kind: "insert" };
  if (existing.sourced_by === senderId) return { kind: "noop" }; // same sourcer sending again
  const stillValid = new Date(existing.expires_at).getTime() > nowMs;
  if (stillValid) {
    // Admin override: let the send through, but leave the claim with whoever
    // earned it. Reassigning here would hand credit to whoever happened to be
    // an admin, which is exactly the silent overwrite this rule exists to stop.
    if (opts.senderIsAdmin) return { kind: "noop" };
    return { kind: "blocked", claimedBy: existing.sourced_by, expiresAt: existing.expires_at };
  }
  return { kind: "reassign", previousSourcedBy: existing.sourced_by }; // expired — allowed, but must be logged/alerted
};

/** The strict one-per-NMLS rule, chosen by the owner after the first week's
 *  live data (233 sends from one LO, ~27% unsubscribe rate): once ANY pro
 *  forma has gone to an external recipient for this NMLS, a further send needs
 *  an admin — including from the original sender. This sits on top of the
 *  claim gate, which only stops OTHER LOs; this one stops repeats outright.
 *
 *  Pure and injected like decideSourcingAction, so the rule is unit-testable:
 *  callers pass the timestamp of the last external send (or null) and the
 *  verified admin flag. */
export const decideRepeatSend = (
  lastExternalSentAt: string | null,
  opts: { senderIsAdmin?: boolean } = {},
): { kind: "allow" } | { kind: "blocked_repeat"; lastSentAt: string } => {
  if (!lastExternalSentAt) return { kind: "allow" };
  if (opts.senderIsAdmin) return { kind: "allow" };
  return { kind: "blocked_repeat", lastSentAt: lastExternalSentAt };
};

export const expiryTimestamp = (nowMs: number, expiryDays: number): string =>
  new Date(nowMs + expiryDays * 24 * 60 * 60 * 1000).toISOString();

/** Recruit-PURL token shape: exactly the 16 lowercase hex chars that
 *  referral_links mints (encode(gen_random_bytes(8), 'hex')). Validated
 *  server-side before the token ever reaches a PostgREST filter. Lives here
 *  (not index.ts) so vitest can reach it. */
export const REFERRAL_TOKEN_RE = /^[0-9a-f]{16}$/;
