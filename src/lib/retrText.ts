// Pure text-parsing logic for a RETR (Real Estate Track Record) export.
// Deliberately has ZERO pdfjs imports so it can be unit-tested under
// vitest/jsdom, where the Vite `?worker` import used by pdfjs cannot load.
//
// src/lib/retrParser.ts extracts `fullText` from the PDF (page text items
// space-joined, pages newline-joined) and delegates here for all
// regex/reconciliation/derivation logic.

export interface RetrParseResult {
  recruitName: string | null;
  nmls: string | null;
  annualVolume: number;       // $ total (purchase + refi + other)
  annualFiles: number;        // total count
  avgLoanAmount: number;      // derived
  purchaseCount: number;
  purchaseVolume: number;
  refiCount: number;
  refiVolume: number;
  // Per RETR's "Summary by Loan Type" — counts only (volume implied)
  byLoanType: {
    fha: number;
    va: number;
    conv: number;    // Conventional + Other rolled in (per user)
    nonqm: number;   // RETR has no Non-QM bucket; always 0 from parse
  };
  rawText: string;
  // Human-readable notes about any values that couldn't be parsed cleanly
  // or that required reconciliation. Empty array = clean parse.
  warnings: string[];
  // Months the figures above actually cover. Only the live-API path
  // (retrApi.ts annualizeLoStats) sets this; the PDF-parse path below always
  // represents a full RETR annual export, so callers default to 12 when unset.
  periodMonths?: number;
}

export const num = (s: string) => Number(s.replace(/[^0-9.]/g, "")) || 0;

export const parseRetrText = (fullText: string): RetrParseResult => {
  const text = fullText;
  const warnings: string[] = [];

  // Recruit name — "Loan Officer Track Record: <Name>"
  const nameMatch = text.match(/Loan Officer Track Record:\s*([^\n]+?)(?:\s{2,}|\s*Hometown|\s*\(NMLS|\s*NMLS)/i)
    || text.match(/Loan Officer Track Record:\s*([A-Z][A-Za-z'’.\- ]+)/);
  const recruitName = nameMatch ? nameMatch[1].trim() : null;
  if (!recruitName) {
    warnings.push("Couldn't find the loan officer name in this PDF.");
  }

  // NMLS number — "NMLS #123456", "NMLS 123456", "(NMLS: 123456)"
  const nmlsMatch = text.match(/NMLS\s*[#:]?\s*(\d{4,12})/i);
  const nmls = nmlsMatch ? nmlsMatch[1] : null;

  // Totals — "Loan Volume: $10,220,790 (37)"
  const volMatch = text.match(/Loan Volume:\s*\$([\d,]+)\s*\((\d+)\)/i);
  const annualVolume = volMatch ? num(volMatch[1]) : 0;
  const annualFiles  = volMatch ? num(volMatch[2]) : 0;

  // Purchase / Refinance — "Purchase: $X (N)"
  const pMatch = text.match(/Purchase:\s*\$([\d,]+)\s*\((\d+)\)/i);
  const rMatch = text.match(/Refinance:\s*\$([\d,]+)\s*\((\d+)\)/i);
  const purchaseVolume = pMatch ? num(pMatch[1]) : 0;
  const purchaseCount  = pMatch ? num(pMatch[2]) : 0;
  const refiVolume     = rMatch ? num(rMatch[1]) : 0;
  const refiCount      = rMatch ? num(rMatch[2]) : 0;

  // Summary by Loan Type — "Conventional: $X (N)", "FHA: $X (N)", "VA: $X (N)", "Other: $X (N)"
  const findType = (label: string) => {
    const m = text.match(new RegExp(`${label}:\\s*\\$([\\d,]+)\\s*\\((\\d+)\\)`, "i"));
    return m ? { vol: num(m[1]), count: num(m[2]) } : { vol: 0, count: 0 };
  };
  const conv  = findType("Conventional");
  const va    = findType("VA");
  const fha   = findType("FHA");
  const other = findType("Other"); // RETR catch-all — user said roll into Conventional

  const counts = {
    fha:   fha.count,
    va:    va.count,
    conv:  conv.count + other.count,
    nonqm: 0,
  };

  // If summed mix doesn't match annualFiles, push/pull the remainder into
  // Conventional so the totals reconcile — but surface exactly what happened
  // instead of silently rewriting the numbers.
  const summed = counts.fha + counts.va + counts.conv + counts.nonqm;
  if (annualFiles > 0 && summed !== annualFiles) {
    const diff = annualFiles - summed;
    if (diff > 0) {
      warnings.push(
        `Loan-type counts (${summed}) fall short of total files (${annualFiles}); the ${diff} unclassified files were counted as Conventional.`
      );
    } else {
      warnings.push(
        `Loan-type counts (${summed}) exceed total files (${annualFiles}); Conventional was reduced by ${-diff} to reconcile.`
      );
    }
    counts.conv += diff;
    if (counts.conv < 0) counts.conv = 0;
  }

  const avgLoanAmount = annualFiles > 0 ? Math.round(annualVolume / annualFiles) : 0;

  return {
    recruitName,
    nmls,
    annualVolume,
    annualFiles,
    avgLoanAmount,
    purchaseCount,
    purchaseVolume,
    refiCount,
    refiVolume,
    byLoanType: counts,
    rawText: text,
    warnings,
  };
};
