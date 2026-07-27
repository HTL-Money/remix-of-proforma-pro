// Shared BPS semantics for "current platform LO comp" entry points (the NMLS
// gate and the Production section field): users type 3-digit basis points
// ("200"), the model stores a percent (2.00) in ModelState.currentSplit.
// Mirrors the Production field's rules at Index.tsx (max 275 BPS).

export const BPS_MAX = 275;

/** "200" → 2.00; ""/invalid/non-positive → null (no comparison, HTL-only view). */
export const bpsToSplit = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, BPS_MAX) / 100;
};
