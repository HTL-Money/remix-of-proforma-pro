// Pure invite/consent rules for recruit-optin, split out of index.ts so vitest
// can cover them without a Deno runtime — same arrangement as
// send-recap/sourcing.ts. index.ts does the I/O; this file decides.

/** Consent lifetime, the owner's choice (12 months, no verbal override). */
export const CONSENT_MONTHS = 12;
/** One invite per mailbox per this many days (a re-invite is a second
 *  unsolicited email). Admins may re-invite inside the window. */
export const REINVITE_DAYS = 30;

/** consented_at + CONSENT_MONTHS, date-safe. `setMonth(+12)` on Feb 29 rolls
 *  to Mar 1, which silently stretched a leap-day consent by a day; this clamps
 *  to the last day of the target month instead. UTC throughout so the result
 *  does not depend on the runtime's zone. */
export const consentExpiry = (nowMs: number): string => {
  const d = new Date(nowMs);
  const total = d.getUTCMonth() + CONSENT_MONTHS;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  )).toISOString();
};

export interface PriorInvite {
  invited_at: string;
  consented_at: string | null;
  consent_expires_at: string | null;
}

export type InviteDecision =
  | { kind: "allow" }
  /** A live consent already exists — the LO can send the pro forma directly. */
  | { kind: "already_consented" }
  /** An invite went out inside the re-invite window and the sender is not an admin. */
  | { kind: "already_invited"; invitedAt: string };

export const decideInvite = (
  prior: PriorInvite | null,
  nowMs: number,
  opts: { senderIsAdmin?: boolean } = {},
): InviteDecision => {
  if (!prior) return { kind: "allow" };
  const consentLive = !!prior.consented_at && !!prior.consent_expires_at
    && new Date(prior.consent_expires_at).getTime() > nowMs;
  if (consentLive) return { kind: "already_consented" };
  const ageMs = nowMs - new Date(prior.invited_at).getTime();
  if (!opts.senderIsAdmin && ageMs < REINVITE_DAYS * 86_400_000) {
    return { kind: "already_invited", invitedAt: prior.invited_at };
  }
  return { kind: "allow" };
};

/** What a consent token currently proves. "consented" tokens keep working
 *  until they lapse (the recruit may come back for their comparison); a
 *  lapsed one no longer proves fresh consent and gets the expired page. */
export type TokenState = "unknown" | "fresh" | "consented" | "lapsed";

export const tokenState = (
  row: { consented_at: string | null; consent_expires_at: string | null } | null,
  nowMs: number,
): TokenState => {
  if (!row) return "unknown";
  if (!row.consented_at) return "fresh";
  const live = !!row.consent_expires_at && new Date(row.consent_expires_at).getTime() > nowMs;
  return live ? "consented" : "lapsed";
};

/** The invite form's optional "what are they paid today" field, in basis
 *  points. Anything that is not a sane positive integer is treated as absent
 *  rather than rejected — the invite is still worth sending without it. */
export const parseBps = (raw: unknown): number | null => {
  const n = typeof raw === "number" ? raw
    : typeof raw === "string" && raw.trim() ? Number(raw.replace(/[^\d.]/g, "")) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r > 0 && r <= 1000 ? r : null;
};

/** Where a confirmed consent lands: the public calculator with the recruit's
 *  NMLS prefilled, the inviting LO's referral token for attribution, and their
 *  current comp so the comparison has a "today" column. */
export const consentRedirectUrl = (appOrigin: string, nmls: string, ref: string | null, bps: number | null): string => {
  const p = new URLSearchParams();
  if (ref) p.set("ref", ref);
  p.set("nmls", nmls);
  if (bps != null && Number.isFinite(bps) && bps > 0) p.set("bps", String(Math.round(bps)));
  return `${appOrigin.replace(/\/$/, "")}/?${p.toString()}`;
};
