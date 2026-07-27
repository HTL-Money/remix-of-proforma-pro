import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { ModelState, Calc } from "@/lib/proforma";
import { requireSupabase } from "@/lib/supabaseClient";

export type { RecapPayload };

export const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Structured numbers only — the Edge Function owns the HTML template. */
export const buildRecapPayload = (savedName: string, state: ModelState, calc: Calc, proformaId?: string): RecapPayload => ({
  savedName,
  loName: state.recruitName,
  nmls: state.nmls,
  volume: state.annualVolume,
  files: state.annualFiles,
  avgLoan: Math.round(state.avgLoanAmount),
  currentBps: state.currentSplit == null ? null : Math.round(state.currentSplit * 100),
  loSplit: state.loSplit,
  holdbackPct: state.holdbackPct,
  corrActive: state.buckets.some(b => b.channel === "Correspondent" && b.active),
  current: { annual: calc.currentPlatformAnnual, monthly: calc.currentPlatformMonthly },
  htl: { annual: calc.finalLoNetComp, monthly: calc.monthlyLoNet },
  gain: { annual: calc.diffAnnual, monthly: calc.diffMonthly },
  buckets: calc.buckets.map(b => ({
    label: b.bucket.label,
    files: b.bucket.fileCount,
    volume: b.dollarVolume,
    compPct: b.bucket.compPct,
    loNet: b.loNetBeforeHoldback,
  })),
  totals: {
    loNetBeforeHoldback: calc.totals.loNetBeforeHoldback,
    teamHoldback: calc.totals.teamHoldback,
    brokerPaidTotal: calc.brokerPaidTotal,
    finalLoNetComp: calc.finalLoNetComp,
  },
  proformaId,
  // Period the production figures cover, so the email labels honestly
  // ("Annual" vs "Previous Six Months") instead of assuming a full year.
  periodMonths: calc.periodMonths,
});

/** Optional binary artifacts riding beside the recap, all base64 (no data:
 *  prefix): the vault-hero GIF and the Word report. Each is independently
 *  best-effort at the call sites — a null generator result just means the
 *  email ships without that extra. */
export interface RecapExtras {
  gif?: string | null;
  docx?: string | null;
  /** Content hash of the Gamma presentation for this recap. When set, the
   *  function waits for that deck's PDF export and attaches it as the
   *  "Documented Pro Forma" — the recruit opens a file, not a link. */
  presentationHash?: string | null;
}

export const sendRecap = async (to: string, recap: RecapPayload, chartPng?: string, extras?: RecapExtras): Promise<void> => {
  const supabase = requireSupabase();
  // Artifacts ride beside recap, never inside it — the function's audit log
  // stores the recap numbers only, not image/attachment bytes.
  const { error } = await supabase.functions.invoke("send-recap", {
    body: {
      to,
      recap,
      ...(chartPng ? { chartPng } : {}),
      ...(extras?.gif ? { gif: extras.gif } : {}),
      ...(extras?.docx ? { docx: extras.docx } : {}),
      ...(extras?.presentationHash ? { presentationHash: extras.presentationHash } : {}),
    },
  });
  if (error) {
    // FunctionsHttpError carries the function's JSON response; surface its message.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = await ctx.json();
        if (body?.error) throw new Error(body.error);
      } catch (e) {
        if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e;
      }
    }
    throw new Error(error.message || "The recap email couldn't be sent.");
  }
};
