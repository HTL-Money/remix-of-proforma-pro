// Unit tests for the pure RETR text-parsing logic. The PDF-upload UI that
// used to call this (src/lib/retrParser.ts, src/components/RetrImport.tsx)
// was removed once the live RETR API superseded it (Part J) — this pure
// regex/reconciliation function is kept, tested, and unused in production
// UI, in case a PDF-import path is ever wanted again.
//
// IMPORTANT: import ONLY from "@/lib/retrText" (or a relative path to it) —
// never a pdfjs-backed module — so this suite stays runnable under jsdom.

import { describe, it, expect } from "vitest";
import { parseRetrText } from "../lib/retrText";

// Fixtures replicate the real extraction shape: per-page text items are
// space-joined, and pages are joined with newlines. We build single-page
// fixtures (one big space-joined line) since none of the regexes are
// newline-sensitive.

describe("parseRetrText", () => {
  // ---- 1. Clean full parse ----
  it("parses a clean, fully-populated RETR export with no warnings", () => {
    const text = [
      "Loan Officer Track Record: Jane Q. Smith Hometown Lending",
      "NMLS #123456",
      "Loan Volume: $10,220,790 (37)",
      "Purchase: $7,000,000 (25)",
      "Refinance: $3,220,790 (12)",
      "Summary by Loan Type",
      "Conventional: $6,000,000 (20)",
      "VA: $2,000,000 (8)",
      "FHA: $1,720,790 (7)",
      "Other: $500,000 (2)",
    ].join(" ");

    const result = parseRetrText(text);

    expect(result.recruitName).toBe("Jane Q. Smith");
    expect(result.nmls).toBe("123456");
    expect(result.annualVolume).toBe(10220790);
    expect(result.annualFiles).toBe(37);
    expect(result.avgLoanAmount).toBe(Math.round(10220790 / 37));
    expect(result.purchaseCount).toBe(25);
    expect(result.purchaseVolume).toBe(7000000);
    expect(result.refiCount).toBe(12);
    expect(result.refiVolume).toBe(3220790);
    // Conventional (20) + Other (2) = 22, VA 8, FHA 7 => sums to 37, matches total.
    expect(result.byLoanType).toEqual({ fha: 7, va: 8, conv: 22, nonqm: 0 });
    expect(result.warnings).toEqual([]);
  });

  // ---- 2. Count shortfall -> Conventional padded up ----
  it("pads Conventional up on a count shortfall and warns with the real numbers", () => {
    const text = [
      "Loan Officer Track Record: Bob Builder NMLS",
      "Loan Volume: $5,000,000 (100)",
      "Purchase: $3,000,000 (60)",
      "Refinance: $2,000,000 (40)",
      "Conventional: $2,000,000 (40)",
      "VA: $1,500,000 (30)",
      "FHA: $1,000,000 (22)",
    ].join(" ");
    // fha 22 + va 30 + conv 40 = 92, short of annualFiles=100 by 8.

    const result = parseRetrText(text);

    expect(result.annualFiles).toBe(100);
    expect(result.byLoanType.fha).toBe(22);
    expect(result.byLoanType.va).toBe(30);
    expect(result.byLoanType.conv).toBe(48); // 40 + 8 padding
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("92");
    expect(result.warnings[0]).toContain("100");
    expect(result.warnings[0]).toContain("8");
    expect(result.warnings[0]).toBe(
      "Loan-type counts (92) fall short of total files (100); the 8 unclassified files were counted as Conventional."
    );
  });

  // ---- 3. Count excess -> Conventional reduced ----
  it("reduces Conventional on a count excess and warns with the real numbers", () => {
    const text = [
      "Loan Officer Track Record: Carla Case NMLS",
      "Loan Volume: $5,000,000 (100)",
      "Purchase: $3,000,000 (60)",
      "Refinance: $2,000,000 (40)",
      "Conventional: $2,500,000 (48)",
      "VA: $1,500,000 (30)",
      "FHA: $1,000,000 (30)",
    ].join(" ");
    // fha 30 + va 30 + conv 48 = 108, exceeds annualFiles=100 by 8.

    const result = parseRetrText(text);

    expect(result.annualFiles).toBe(100);
    expect(result.byLoanType.fha).toBe(30);
    expect(result.byLoanType.va).toBe(30);
    expect(result.byLoanType.conv).toBe(40); // 48 - 8
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe(
      "Loan-type counts (108) exceed total files (100); Conventional was reduced by 8 to reconcile."
    );
  });

  // ---- 4. Missing/unmatchable LO name ----
  it("produces a name warning but still parses every other field when the name is unmatchable", () => {
    const text = [
      "Some Other Report Header With No LO Name Pattern",
      "Loan Volume: $1,000,000 (10)",
      "Purchase: $600,000 (6)",
      "Refinance: $400,000 (4)",
      "Conventional: $700,000 (7)",
      "VA: $200,000 (2)",
      "FHA: $100,000 (1)",
    ].join(" ");

    const result = parseRetrText(text);

    expect(result.recruitName).toBeNull();
    expect(result.warnings).toContain("Couldn't find the loan officer name in this PDF.");
    // Every other field still parses normally.
    expect(result.annualVolume).toBe(1000000);
    expect(result.annualFiles).toBe(10);
    expect(result.purchaseCount).toBe(6);
    expect(result.refiCount).toBe(4);
    expect(result.byLoanType).toEqual({ fha: 1, va: 2, conv: 7, nonqm: 0 });
  });

  // ---- 5. "Other" folds into Conventional ----
  it("folds the 'Other' loan-type line into Conventional", () => {
    const text = [
      "Loan Officer Track Record: Dana Doe NMLS",
      "Loan Volume: $1,000,000 (20)",
      "Purchase: $600,000 (12)",
      "Refinance: $400,000 (8)",
      "Conventional: $500,000 (10)",
      "VA: $200,000 (4)",
      "FHA: $150,000 (3)",
      "Other: $150,000 (3)",
    ].join(" ");
    // fha 3 + va 4 + (conv 10 + other 3 = 13) = 20, matches total exactly — no reconciliation needed.

    const result = parseRetrText(text);

    expect(result.byLoanType.conv).toBe(13);
    expect(result.byLoanType.fha).toBe(3);
    expect(result.byLoanType.va).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  // ---- 6. Malformed/absent "Loan Volume" line ----
  // Characterizing current behavior: parseRetrText does NOT throw when the
  // "Loan Volume: $X (N)" line is missing or malformed — it silently returns
  // zeros for annualVolume/annualFiles (and 0 for avgLoanAmount, since that's
  // guarded by `annualFiles > 0`). No warning is emitted for this case either.
  // (RetrImport.tsx is the layer that turns "annualVolume or annualFiles falsy"
  // into a thrown, user-facing error — see its `handle()` — but the parser
  // itself is silent. This looks like a latent gap: a parser-level warning
  // would let callers other than RetrImport detect the failure too.)
  it("characterizes current behavior: absent Loan Volume line yields zeros, not a throw, and no warning", () => {
    const text = [
      "Loan Officer Track Record: Eli Example NMLS",
      "Purchase: $600,000 (12)",
      "Refinance: $400,000 (8)",
      "Conventional: $500,000 (10)",
    ].join(" ");

    const result = parseRetrText(text);

    expect(result.annualVolume).toBe(0);
    expect(result.annualFiles).toBe(0);
    expect(result.avgLoanAmount).toBe(0);
    // Reconciliation is skipped entirely because `annualFiles > 0` is false,
    // so byLoanType.conv is NOT padded and no reconciliation warning fires.
    expect(result.byLoanType.conv).toBe(10);
    expect(result.warnings).toEqual([]);
  });

  it("characterizes current behavior: a malformed Loan Volume line (no parenthesized count) also yields zeros", () => {
    const text = [
      "Loan Officer Track Record: Fay Fixture NMLS",
      "Loan Volume: $1,000,000 total, no file count given",
      "Conventional: $500,000 (10)",
    ].join(" ");

    const result = parseRetrText(text);

    expect(result.annualVolume).toBe(0);
    expect(result.annualFiles).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  // ---- 7. Number formatting robustness ----
  it("strips commas and dollar signs via num() to produce correct integers", () => {
    const text = [
      "Loan Officer Track Record: Gia Gross NMLS",
      "Loan Volume: $12,345,678 (45)",
      "Purchase: $8,000,000 (30)",
      "Refinance: $4,345,678 (15)",
      "Conventional: $9,345,678 (35)",
      "VA: $2,000,000 (7)",
      "FHA: $1,000,000 (3)",
    ].join(" ");
    // fha 3 + va 7 + conv 35 = 45, matches total exactly.

    const result = parseRetrText(text);

    expect(result.annualVolume).toBe(12345678);
    expect(result.annualFiles).toBe(45);
    expect(result.purchaseVolume).toBe(8000000);
    expect(result.refiVolume).toBe(4345678);
    expect(result.byLoanType).toEqual({ fha: 3, va: 7, conv: 35, nonqm: 0 });
    expect(result.warnings).toEqual([]);
  });

  // ---- 8. NMLS extraction ----
  it("extracts the NMLS number from 'NMLS 123456' (no hash) and '(NMLS: 987654)' shapes", () => {
    const hashless = parseRetrText([
      "Loan Officer Track Record: Ida Digit NMLS 445566",
      "Loan Volume: $1,000,000 (10)",
      "Conventional: $1,000,000 (10)",
    ].join(" "));
    expect(hashless.nmls).toBe("445566");

    const parenColon = parseRetrText([
      "Loan Officer Track Record: Jo Paren (NMLS: 987654)",
      "Loan Volume: $1,000,000 (10)",
      "Conventional: $1,000,000 (10)",
    ].join(" "));
    expect(parenColon.nmls).toBe("987654");
  });

  it("returns null nmls when the NMLS token has no number after it", () => {
    const result = parseRetrText([
      "Loan Officer Track Record: Bob Builder NMLS",
      "Loan Volume: $5,000,000 (100)",
      "Conventional: $5,000,000 (100)",
    ].join(" "));
    expect(result.nmls).toBeNull();
  });

  it("handles a large parenthesized file count alongside a comma-formatted dollar amount", () => {
    const text = [
      "Loan Officer Track Record: Hank Huge NMLS",
      "Loan Volume: $100,000,000 (1234)",
      "Conventional: $100,000,000 (1234)",
    ].join(" ");

    const result = parseRetrText(text);

    // The file-count capture group is `(\d+)` — digits only, no comma class.
    // Real RETR exports never put a comma inside the parenthesized count, so
    // this fixture matches that real-world shape. (Verified separately: if a
    // comma WERE present inside the parens, e.g. "(1,234)", the entire
    // "Loan Volume: $X (N)" regex fails to match — not "matches then strips
    // the comma" — because the mismatch happens before num() ever runs on
    // the second capture group. That would silently zero out annualVolume
    // and annualFiles, same as the missing-line case in category 6 above.)
    expect(result.annualVolume).toBe(100000000);
    expect(result.annualFiles).toBe(1234);
    expect(result.avgLoanAmount).toBe(Math.round(100000000 / 1234));
  });
});
