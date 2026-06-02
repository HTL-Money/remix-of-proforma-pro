// Parses a RETR (Real Estate Track Record) PDF and extracts the fields needed
// to populate the LO Pro Forma calculator. Runs fully client-side via pdfjs-dist.

import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - Vite worker import
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface RetrParseResult {
  recruitName: string | null;
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
}

const num = (s: string) => Number(s.replace(/[^0-9.]/g, "")) || 0;

export const parseRetrPdf = async (file: File): Promise<RetrParseResult> => {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it: any) => it.str).join(" ") + "\n";
  }

  // Recruit name — "Loan Officer Track Record: <Name>"
  const nameMatch = text.match(/Loan Officer Track Record:\s*([^\n]+?)(?:\s{2,}|\s*Hometown|\s*\(NMLS|\s*NMLS)/i)
    || text.match(/Loan Officer Track Record:\s*([A-Z][A-Za-z'’.\- ]+)/);
  const recruitName = nameMatch ? nameMatch[1].trim() : null;

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

  // If summed mix < annualFiles, push the remainder into Conventional so the totals match.
  const summed = counts.fha + counts.va + counts.conv + counts.nonqm;
  if (annualFiles > 0 && summed !== annualFiles) {
    counts.conv += annualFiles - summed;
    if (counts.conv < 0) counts.conv = 0;
  }

  const avgLoanAmount = annualFiles > 0 ? Math.round(annualVolume / annualFiles) : 0;

  return {
    recruitName,
    annualVolume,
    annualFiles,
    avgLoanAmount,
    purchaseCount,
    purchaseVolume,
    refiCount,
    refiVolume,
    byLoanType: counts,
    rawText: text,
  };
};
