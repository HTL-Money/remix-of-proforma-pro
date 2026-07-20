// Client for the retr-proxy Edge Function (live RETR loan-officer stats) and
// the pure mapping from RETR's API shape onto the calculator's RetrParseResult.
//
// Imports types from retrText (never retrParser) so this module stays free of
// pdfjs and unit-testable under vitest/jsdom.

import { RetrParseResult } from "@/lib/retrText";
import { supabase } from "@/lib/supabaseClient";

export type RetrDateRange = 3 | 6 | 12 | 14;
export const RETR_DEFAULT_RANGE: RetrDateRange = 6;
export const RETR_RANGE_OPTIONS: { value: RetrDateRange; label: string }[] = [
  { value: 3, label: "3 mo" },
  { value: 6, label: "6 mo" },
  { value: 12, label: "12 mo" },
  { value: 14, label: "14 mo" },
];

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
 * Map a windowed RETR stats pull onto the calculator's annual fields.
 *
 * The calculator models a 12-month year, so a 3/6/14-month window is scaled
 * by 12/months ("annualized pace") — flagged in `warnings` so the UI can say
 * so. The average loan amount is window-invariant and never scaled. Conv
 * absorbs whatever the FHA/VA counts don't cover (jumbo, non-QM, reverse,
 * other), the same convention the PDF parser uses, so the mix always
 * reconciles to the annualized file count.
 */
export const annualizeLoStats = (dto: LoanOfficerStatsDto, months: RetrDateRange): RetrParseResult => {
  const factor = 12 / months;
  const scale = (n: number | null | undefined) => Math.round((n ?? 0) * factor);

  const rawCount = dto.loanCount ?? 0;
  const rawVolume = dto.loanVolume ?? 0;
  const annualFiles = scale(rawCount);
  const annualVolume = Math.round(rawVolume * factor);
  const avgLoanAmount = rawCount > 0 ? rawVolume / rawCount : 0;

  const fha = Math.min(scale(dto.fhaCount), annualFiles);
  const va = Math.min(scale(dto.vaCount), Math.max(0, annualFiles - fha));
  const conv = Math.max(0, annualFiles - fha - va);

  const purchaseCount = scale(dto.purchaseCount);
  const refiCount = scale(dto.refiCount);
  // RETR's DTO has no purchase/refi volume split — derive from the average.
  const purchaseVolume = Math.round(avgLoanAmount * purchaseCount);
  const refiVolume = Math.round(avgLoanAmount * refiCount);

  const recruitName = [dto.firstName, dto.lastName].filter(Boolean).join(" ").trim() || null;

  const warnings: string[] = [];
  if (months !== 12) {
    warnings.push(`Live RETR pull over a ${months}-month window — annualized ×${factor.toFixed(2)}.`);
  }

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
    rawText: `RETR API live pull (${months}-month window): ${JSON.stringify(dto)}`,
    warnings,
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
