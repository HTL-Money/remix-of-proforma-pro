// Map a parsed RETR report onto the model — shared by the NMLS gate, the
// "Pull RETR data" button, and the ?nmls= deep link. Pure so it's testable:
// the important invariant is retrSourced=true, which locks the production
// fields read-only and marks every sent artifact as RETR-verified.
import { ModelState } from "@/lib/proforma";
import { RetrParseResult } from "@/lib/retrText";

export const applyRetrResult = (s: ModelState, r: RetrParseResult): ModelState => {
  const total = r.annualFiles;
  const pct = (n: number) => total > 0 ? (n / total) * 100 : 0;
  return {
    ...s,
    recruitName: r.recruitName ?? s.recruitName,
    nmls: r.nmls ?? s.nmls,
    annualVolume: r.annualVolume,
    annualFiles: r.annualFiles,
    avgLoanAmount: r.avgLoanAmount || s.avgLoanAmount,
    avgLoanOverride: false,
    loanTypeMix: {
      fha: pct(r.byLoanType.fha),
      va: pct(r.byLoanType.va),
      conv: pct(r.byLoanType.conv),
      nonqm: pct(r.byLoanType.nonqm),
    },
    productionPeriodMonths: r.periodMonths ?? 12,
    retrSourced: true,
  };
};
