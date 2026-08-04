// The one full recap-send pipeline, shared by every surface that emails a
// recruit their pro forma: the public "Email me this recap" dialog
// (PublicRecapCta) and the team's "Send It Now" action on /links. Extracted
// so the artifact set (ceiling visual, Word report, Gamma deck) and its
// best-effort semantics can never drift between the two.
import { ModelState, Calc } from "@/lib/proforma";
import { buildRecapPayload, sendRecap } from "@/lib/recapEmail";
import { renderRecapChartPng } from "@/lib/recapChart";
import { renderCeilingVisualPng } from "@/lib/ceilingVisual";
import { buildRecapDocxBase64 } from "@/lib/recapDocx";
import { hashRecap } from "@/lib/recapLink";
import { enqueueRecapPresentation } from "@/lib/gammaPresentation";

export const sendFullRecap = async (
  name: string,
  state: ModelState,
  calc: Calc,
  to: string,
  opts?: { referralToken?: string | null },
): Promise<void> => {
  const payload = buildRecapPayload(name, state, calc);
  // The "Your ceiling just moved" visual is the email body; the classic
  // chart is the fallback when the artwork can't render. Both best-effort.
  const chartPng = (await renderCeilingVisualPng(payload)) ?? renderRecapChartPng(payload);
  // Word report: best-effort (returns null rather than throws) — a
  // rendering hiccup never blocks the email. The presentation (Gamma) is
  // the single deliverable in the email body now — no separate graphic.
  const docx = await buildRecapDocxBase64(payload);
  // Start the Gamma deck BEFORE sending: the recruit receives it as an
  // attachment, so send-recap has to be able to wait for this exact
  // generation. Awaited (not fire-and-forget) only so the row exists
  // before the send begins; the generation itself still runs async and
  // is polled server-side. A failure here is non-fatal — the email then
  // goes out without the attachment rather than not at all.
  const presentationHash = hashRecap(payload);
  try {
    await enqueueRecapPresentation(presentationHash, payload);
  } catch (e) {
    console.warn("Presentation could not be queued; sending without it:", e);
  }
  await sendRecap(to, payload, chartPng ?? undefined, {
    docx,
    presentationHash,
    referralToken: opts?.referralToken,
  });
};
