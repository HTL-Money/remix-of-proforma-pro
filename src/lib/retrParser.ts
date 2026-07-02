// Parses a RETR (Real Estate Track Record) PDF and extracts the fields needed
// to populate the LO Pro Forma calculator. Runs fully client-side via pdfjs-dist.
//
// All pure text-parsing logic (regex/reconciliation/derivation) lives in
// ./retrText.ts, which has zero pdfjs imports and is unit-tested directly.
// This module owns only pdfjs worker setup and PDF -> fullText extraction.

import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - Vite worker import
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { parseRetrText } from "./retrText";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

// Re-exported so existing importers of retrParser.ts keep working unchanged.
export type { RetrParseResult } from "./retrText";

export const parseRetrPdf = async (file: File) => {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it: any) => it.str).join(" ") + "\n";
  }

  return parseRetrText(text);
};
