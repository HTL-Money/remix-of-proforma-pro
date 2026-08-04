// Pure prompt-building logic for the Gamma "Documented Pro Forma" deck —
// separated from index.ts's Deno handler (same convention as send-recap's
// sourcing.ts/template.ts) so vitest can cover the copy directly.
//
// "You Already Know" — chosen because the earlier persona-review panel found
// this audience (skeptical, financially sophisticated loan officers) reacts
// against hype-toned pitches; this reads as "just the math," not a sales
// pitch. Built from RecapPayload's numbers only — never employee data (there
// is none in RecapPayload), never the HTL5 sourcing info (that's backend-only
// and never touches anything sent to the recipient).
//
// The team-economics slide (owner request): when the recruit brings a team,
// the deck must explain plainly how launching their own operation works —
// their production funds their team's payroll, and the rest is theirs. The
// word "holdback" is internal vocabulary and NEVER appears in recruit-facing
// copy (that invariant is test-enforced in src/test/gammaPrompt.test.ts).

export const usd = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    isFinite(n) ? n : 0,
  );

export interface RecapForPrompt {
  loName?: string;
  current?: { annual?: number | null } | null;
  htl?: { annual?: number } | null;
  gain?: { annual?: number | null } | null;
  volume?: number;
  files?: number;
  totals?: {
    loNetBeforeHoldback?: number | null;
    brokerPaidTotal?: number | null;
    finalLoNetComp?: number | null;
  } | null;
}

/** True when this recruit has real team payroll to explain — the trigger for
 *  the "Your Team Economics" slide (and the 7th deck card). */
export const hasTeamEconomics = (recap: RecapForPrompt): boolean =>
  (recap.totals?.brokerPaidTotal ?? 0) > 0;

export const buildInputText = (recap: RecapForPrompt): string => {
  const name = recap.loName || "you";
  const current = recap.current?.annual ?? null;
  const htl = recap.htl?.annual ?? 0;
  const gain = recap.gain?.annual ?? null;
  const hasComparison = current != null && gain != null;
  const gainLine = hasComparison
    ? `The gap: ${usd(gain ?? 0)} a year — ${usd(current ?? 0)} today vs. ${usd(htl)} at Hometown Lending.`
    : `Projected annual comp at Hometown Lending: ${usd(htl)}.`;
  const teamLine = hasTeamEconomics(recap)
    ? `Add one slide titled "Your Team Economics" — a simple, visual breakdown (a clean 3-step ` +
      `waterfall, not a spreadsheet) showing how launching with a team works: LO net before payroll ` +
      `${usd(recap.totals?.loNetBeforeHoldback ?? 0)}, minus your team's payroll cost ` +
      `${usd(recap.totals?.brokerPaidTotal ?? 0)}, equals your final net comp ` +
      `${usd(recap.totals?.finalLoNetComp ?? 0)}. Frame it plainly as funding your own team out of ` +
      `your own production, the same way any owner covers staff payroll before taking home the ` +
      `rest — never as a fee, deduction, or penalty.`
    : "";
  return [
    `Create a short, restrained, premium mortgage-industry presentation for a loan officer named ${name}.`,
    `Tone: direct and factual, NOT hype or sales-pitchy — this audience is financially sophisticated and skeptical of hype.`,
    `Headline concept: "You already know you're leaving money on the table. Here's exactly how much."`,
    gainLine,
    `Production: ${recap.files ?? 0} files, ${usd(recap.volume ?? 0)} in annual volume — same production, different split.`,
    teamLine,
    `Close with a low-pressure invitation to a short, no-commitment call — never claim these figures are guaranteed; they are illustrative.`,
    // Brand/palette guidance intentionally lives in brandInstructions() in
    // index.ts, passed as Gamma's additionalInstructions, so it isn't
    // duplicated here.
  ]
    .filter(Boolean)
    .join(" ");
};
