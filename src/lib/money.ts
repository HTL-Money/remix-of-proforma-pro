// Shorthand-tolerant money parsing: "48m" → 48,000,000, "$480k" → 480,000,
// "2mm" → 2,000,000, "48,000,000" → 48,000,000. Empty / junk → 0.
export const parseMoney = (raw: string): number => {
  const s = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return 0;
  const m = s.match(/^(\d*\.?\d+)(k|m|mm|b)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    const mult = m[2] === "k" ? 1e3 : m[2] === "m" || m[2] === "mm" ? 1e6 : m[2] === "b" ? 1e9 : 1;
    return isFinite(n) ? n * mult : 0;
  }
  // Fallback: strip everything non-numeric and take what's left.
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
};
