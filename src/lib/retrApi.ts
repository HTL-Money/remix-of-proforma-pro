// Client for the retr-proxy Edge Function (live RETR loan-officer stats) and
// the pure mapping from RETR's API shape onto the calculator's RetrParseResult.
//
// Imports types from retrText (never retrParser) so this module stays free of
// pdfjs and unit-testable under vitest/jsdom.

import { RetrParseResult } from "@/lib/retrText";
import { supabase } from "@/lib/supabaseClient";

export type RetrDateRange = 3 | 6 | 12 | 14;
export const RETR_DEFAULT_RANGE: RetrDateRange = 12;
export const RETR_RANGE_OPTIONS: { value: RetrDateRange; label: string }[] = [
  { value: 3, label: "3 mo" },
  { value: 6, label: "6 mo" },
  { value: 12, label: "12 mo" },
  { value: 14, label: "14 mo" },
];

const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
  7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
};

/**
 * Human phrase for a production window: "annual" at exactly 12 months,
 * "previous N months" under a year, "N years" for a clean multi-year
 * multiple of 12, and the literal "N months" for anything else (e.g. 14).
 * Drives every field/recap label that used to hardcode "Annual" — so a
 * pull that isn't a full year never claims to be one.
 */
export const periodLabel = (months: number): string => {
  if (months === 12) return "annual";
  if (months < 12) {
    const word = NUMBER_WORDS[months] ?? String(months);
    return `previous ${word} month${months === 1 ? "" : "s"}`;
  }
  if (months % 12 === 0) {
    const years = months / 12;
    const word = NUMBER_WORDS[years] ?? String(years);
    return `${word} year${years === 1 ? "" : "s"}`;
  }
  return `${months} months`;
};

/** Title-cased variant for field labels, e.g. "Previous Three Months". */
export const periodLabelTitle = (months: number): string =>
  periodLabel(months).replace(/\b\w/g, c => c.toUpperCase());

/** RETR's LoanOfficerStatsDto, per their OpenAPI spec. */
export interface LoanOfficerStatsDto {
  firstName: string | null;
  lastName: string | null;
  nmlsId: number;
  loanCount: number;
  loanVolume: number;
  purchaseCount: number;
  refiCount: number;
  branch?: string | null;
  branchNMLSID?: number | null;
  company?: string | null;
  companyNMLSID?: number | null;
  convCount: number;
  fhaCount: number;
  vaCount: number;
  newBuildCount?: number;
  existingHomeCount?: number;
  reverseCount?: number;
}

/**
 * Map a windowed RETR stats pull onto the calculator's fields — as the
 * ACTUAL figures for that window, never annualized. A 6-month pull shows a
 * real 6-month total labeled "previous six months," not a ×2 estimate
 * wearing an "annual" label (the guessed-comp/compliance concern a shorter
 * window used to create). `periodMonths` carries the window forward so
 * `calculate()` can keep "monthly" and employee-salary proration honest for
 * whatever period this is. The average loan amount is naturally
 * window-invariant (a per-loan average, not a total). Conv absorbs whatever
 * the FHA/VA counts don't cover (jumbo, non-QM, reverse, other), the same
 * convention the PDF parser uses, so the mix always reconciles to the
 * window's file count.
 */
export const annualizeLoStats = (dto: LoanOfficerStatsDto, months: RetrDateRange): RetrParseResult => {
  const annualFiles = Math.round(dto.loanCount ?? 0);
  const annualVolume = Math.round(dto.loanVolume ?? 0);
  const avgLoanAmount = annualFiles > 0 ? annualVolume / annualFiles : 0;

  const fha = Math.min(Math.round(dto.fhaCount ?? 0), annualFiles);
  const va = Math.min(Math.round(dto.vaCount ?? 0), Math.max(0, annualFiles - fha));
  const conv = Math.max(0, annualFiles - fha - va);

  const purchaseCount = Math.round(dto.purchaseCount ?? 0);
  const refiCount = Math.round(dto.refiCount ?? 0);
  // RETR's DTO has no purchase/refi volume split — derive from the average.
  const purchaseVolume = Math.round(avgLoanAmount * purchaseCount);
  const refiVolume = Math.round(avgLoanAmount * refiCount);

  const recruitName = [dto.firstName, dto.lastName].filter(Boolean).join(" ").trim() || null;

  return {
    recruitName,
    nmls: dto.nmlsId ? String(dto.nmlsId) : null,
    annualVolume,
    annualFiles,
    avgLoanAmount,
    purchaseCount,
    purchaseVolume,
    refiCount,
    refiVolume,
    byLoanType: { fha, va, conv, nonqm: 0 },
    rawText: `RETR API live pull (${months}-month window, actual — not annualized): ${JSON.stringify(dto)}`,
    warnings: [],
    periodMonths: months,
  };
};

/**
 * Live lookup via the retr-proxy Edge Function. Returns null for every
 * "no live data" case — function not deployed, credentials not set (503),
 * NMLS unknown to RETR, network failure — so callers can quietly fall back
 * to the shared report store / manual entry.
 */
export const fetchLoStats = async (
  nmls: string,
  dateRange: RetrDateRange = RETR_DEFAULT_RANGE,
): Promise<{ dto: LoanOfficerStatsDto; fetchedAt: string | null } | null> => {
  if (!supabase) return null;
  const nmlsId = Number(nmls);
  if (!Number.isInteger(nmlsId) || nmlsId < 1 || nmlsId > 2147483647) return null;
  try {
    const { data, error } = await supabase.functions.invoke("retr-proxy", { body: { nmlsId, dateRange } });
    if (error || !data?.ok || !data.data) return null;
    return { dto: data.data as LoanOfficerStatsDto, fetchedAt: (data.fetchedAt as string) ?? null };
  } catch {
    return null;
  }
};
