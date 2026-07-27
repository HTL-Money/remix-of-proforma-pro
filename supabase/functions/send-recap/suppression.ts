// Suppression-check logic for send-recap, split out of index.ts so vitest
// can unit-test it (index.ts calls Deno.serve at module scope and can't be
// imported outside Deno — same reason template.ts is a separate module).
//
// Policy: the check FAILS CLOSED. If the suppression lookup can't complete,
// the send is refused with a retryable error rather than risked — emailing
// someone who opted out is a per-message CAN-SPAM violation, while a recruit
// retrying a minute later costs nothing. (Contrast: the RATE limit fails
// open, because its failure mode is merely an extra courtesy email.)

/** Addresses are stored lowercase; compare apples to apples. */
export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

export type SuppressionVerdict = "send" | "suppressed" | "unavailable";

/**
 * Decide from the raw lookup outcome.
 *  - resp null / !ok / non-array rows → "unavailable" (fail closed upstream)
 *  - one or more rows → "suppressed"
 *  - empty array → "send"
 */
export const suppressionVerdict = (resp: { ok: boolean; rows: unknown } | null): SuppressionVerdict => {
  if (!resp || !resp.ok || !Array.isArray(resp.rows)) return "unavailable";
  return resp.rows.length > 0 ? "suppressed" : "send";
};
