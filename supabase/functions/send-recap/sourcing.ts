// Pure HTL5 referral-sourcing decision logic — deliberately separated from
// index.ts's I/O (same reason template.ts is separated: zero Deno-specific
// globals, so it's importable and testable under vitest directly).
//
// The actual database reads/writes and the alert email live in index.ts;
// this file only decides WHAT should happen given the current state.

import { normalizeEmail } from "./suppression.ts";
import { tierForAnnualVolume } from "./splitTiers.ts";

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

// ---- Canonical identifiers --------------------------------------------------

/** NMLS numbers arrive from a client-built payload. The claim, repeat and
 *  sourcing gates all key on the string, so "0207433", "207-433" and
 *  "207433 " must collapse to one recruit — otherwise the same person could be
 *  sent to three times while the email showed "their" number each time. */
export const normalizeNmls = (raw: unknown): string => String(raw ?? "").replace(/\D/g, "");

/** The longest NMLS ID the registry issues is well under this; anything longer
 *  is a crafted payload. */
export const NMLS_MAX_DIGITS = 12;

/** Internal addresses are previews and tests: they never consume consent, a
 *  claim, or the one-per-NMLS rule. One definition, used by every gate and by
 *  the PostgREST filter in the repeat lookup. */
export const INTERNAL_DOMAIN = "@hometownlend.com";
export const isInternalRecipient = (email: string): boolean => normalizeEmail(email).endsWith(INTERNAL_DOMAIN);

// ---- Opt-in gate -----------------------------------------------------------

/** The owner's consent rule for LO-initiated sends: no live recruit_optins row,
 *  no send — unless a VERIFIED admin is the sender. Pure so the admin override
 *  and the consent requirement are tested rather than trusted. */
export const decideOptinSend = (
  hasLiveConsent: boolean,
  opts: { senderIsAdmin?: boolean } = {},
): { kind: "allow" } | { kind: "blocked_no_optin" } =>
  hasLiveConsent || opts.senderIsAdmin ? { kind: "allow" } : { kind: "blocked_no_optin" };

// ---- Split gate ------------------------------------------------------------

/** Same annualization as calculate(): a 6-month $15M pull is a $30M/yr pace. */
export const annualizedVolume = (volume: number | null | undefined, periodMonths: number | null | undefined): number => {
  const months = typeof periodMonths === "number" && periodMonths > 0 ? periodMonths : 12;
  return (volume ?? 0) * (12 / months);
};

export type SplitDecision =
  | { kind: "allow"; derived: number }
  /** A verified admin granted a better split than the volume earns; recorded
   *  on the pro forma row as the override audit. */
  | { kind: "override"; derived: number }
  | { kind: "blocked_split"; derived: number };

/** The payload's loSplit is attacker-chosen (the anon key ships in the
 *  bundle), so the band the volume actually earns is recomputed here and a
 *  better claimed split is refused from anyone but a verified admin. A worse
 *  split is always allowed — quoting below band harms nobody. */
export const decideSplit = (
  loSplit: number,
  volume: number | null | undefined,
  periodMonths: number | null | undefined,
  opts: { senderIsAdmin?: boolean } = {},
): SplitDecision => {
  const derived = tierForAnnualVolume(annualizedVolume(volume, periodMonths)).loPct;
  if (loSplit <= derived) return { kind: "allow", derived };
  return opts.senderIsAdmin ? { kind: "override", derived } : { kind: "blocked_split", derived };
};
