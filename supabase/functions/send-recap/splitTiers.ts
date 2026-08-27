// The HTL LO split tier table — the published comp rule, in one place.
//
// Lives inside send-recap (not src/lib) because BOTH sides need it and the
// import can only flow this direction: the browser app imports from
// supabase/functions freely (template.ts set that precedent), while a Deno
// edge function cannot reach src/. The server needs it because since the
// admin split override shipped, "what split does this volume earn?" is an
// AUTHORIZATION question — send-recap recomputes the tier from the payload's
// volume and refuses a claimed split the volume doesn't earn unless a
// verified admin sent it. A copy of this table drifting between app and
// server would mean the UI shows one band and the server enforces another.
//
// The published rule, verbatim:
//   up to $23,999,999/yr → 80/20
//   $24,000,000 – $47,999,999/yr → 85/15
//   $48,000,000/yr and up → 90/10
// Boundaries land in the UPPER band: exactly $24M is 85/15, exactly $48M is 90/10.
// The band is a function of ANNUAL funded volume — monthly equivalents are
// just ÷12 for readers who think in months.

export interface SplitTier {
  loPct: number;
  htlPct: number;
  /** Inclusive lower bound on annual funded volume. */
  minAnnual: number;
  /** Exclusive upper bound on annual funded volume; null = no ceiling. */
  maxAnnual: number | null;
}

export const SPLIT_TIERS: SplitTier[] = [
  { loPct: 80, htlPct: 20, minAnnual: 0,          maxAnnual: 24_000_000 },
  { loPct: 85, htlPct: 15, minAnnual: 24_000_000, maxAnnual: 48_000_000 },
  { loPct: 90, htlPct: 10, minAnnual: 48_000_000, maxAnnual: null },
];

/** The LO percentages an admin may override to — read from the table, never a
 *  parallel literal, so adding a tier can't leave the override control stale. */
export const OVERRIDE_SPLITS: number[] = SPLIT_TIERS.map(t => t.loPct);

/** The tier a given annual funded volume qualifies for. Boundaries land in the UPPER band. */
export const tierForAnnualVolume = (annualVolume: number): SplitTier =>
  SPLIT_TIERS.find(t => t.maxAnnual == null || annualVolume < t.maxAnnual) ?? SPLIT_TIERS[SPLIT_TIERS.length - 1];
