// Builds the prompt for the one personalized paragraph that opens the recap
// email. Split out of index.ts's Deno handler — same convention as
// gamma-proxy/prompt.ts and sourcing.ts — so vitest can cover the copy rules
// directly, without a Deno runtime.
//
// WHY THIS CARRIES NO FIGURES
//
// The recap makes income representations to a prospective hire. Every dollar
// amount and percentage in it is rendered deterministically by template.ts from
// a validated RecapPayload, so the same inputs always produce the same claims
// and the copy can be reviewed once. A model paraphrasing those numbers would
// hand each recruit slightly different, never-reviewed earnings language — so
// this paragraph is prompted to state none of them. It supplies context and
// address; the table immediately beneath it supplies the math.
//
// Tone is inherited from the same decision recorded in gamma-proxy/prompt.ts:
// the persona-review panel found this audience (skeptical, financially
// sophisticated loan officers) reacts against hype. "More human" here means
// plainer and more specific, NOT warmer or more enthusiastic.

/** The slice of the recap this paragraph is allowed to know about. Deliberately
 *  narrow: bands and counts, never the computed comp figures. */
export interface NarrativeFacts {
  loName?: string;
  /** Annual funded volume, used only to pick a band description. */
  volume?: number;
  files?: number;
  /** True when the recruit runs a team whose payroll they cover. */
  hasTeam?: boolean;
  /** True when production was hand-entered rather than pulled from RETR. */
  selfReported?: boolean;
}

/** Coarse volume band. The paragraph may describe the shape of someone's book
 *  ("a high-volume desk") but never the number itself. */
export const volumeBand = (volume?: number): string => {
  const v = volume ?? 0;
  if (v >= 48_000_000) return "very high volume";
  if (v >= 24_000_000) return "high volume";
  if (v >= 10_000_000) return "solid, established volume";
  if (v > 0) return "a developing book";
  return "unstated volume";
};

/** Words that must never appear in the generated paragraph, because each one
 *  either leaks internal vocabulary or makes a claim the template owns. */
export const BANNED_IN_NARRATIVE = [
  "holdback",
  "guarantee",
  "guaranteed",
  "promise",
  "offer of employment",
];

export const SYSTEM_PROMPT = [
  "You write one short opening paragraph for a compensation summary that a mortgage",
  "recruiter sends to an individual loan officer.",
  "",
  "Hard rules, all of them absolute:",
  "- State NO numbers. No dollar amounts, no percentages, no file counts, no splits,",
  "  no years. The document itself shows every figure directly below your paragraph.",
  "- Make no promise, guarantee, or offer of employment.",
  "- Never use the word \"holdback\".",
  "- 2 to 3 sentences. Under 60 words. One paragraph, plain text, no markdown, no heading.",
  "- Address the reader as \"you\". Do not open with their name; the email already greets them.",
  "",
  "Tone: direct, specific, unhurried. This reader is financially sophisticated and",
  "reacts badly to hype, flattery, and salesmanship. Do not sell, do not compliment,",
  "do not use exclamation marks. Say something true and concrete about their situation",
  "and what the figures below are, then stop.",
].join("\n");

/** The per-recruit user turn. Facts only — the system prompt carries the rules. */
export const buildNarrativePrompt = (f: NarrativeFacts): string => {
  const lines = [
    `This loan officer runs ${volumeBand(f.volume)}.`,
    f.hasTeam
      ? "They run a team whose payroll comes out of their own production, so the summary below separates what the team costs from what they keep."
      : "They produce solo, so the summary below is a straight split comparison.",
    f.selfReported
      ? "Their production figures were provided by hand rather than pulled from public records, so avoid implying the numbers were independently verified."
      : "Their production figures came from public licensing records.",
    "The summary below compares what they earn today with what the same production would pay at Hometown Lending.",
    "Write the opening paragraph.",
  ];
  return lines.filter(Boolean).join(" ");
};

/** Post-generation gate. The prompt forbids figures, but a prompt is not an
 *  enforcement mechanism — this is. Returns null when the paragraph breaks a
 *  rule, and the caller then sends the email without it. Rejecting is always
 *  safe here; the numbers never depended on this text. */
export const validateNarrative = (text: string | null | undefined): string | null => {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  // Length: a runaway response is a sign the model ignored the brief.
  if (t.length > 600) return null;
  const lower = t.toLowerCase();
  if (BANNED_IN_NARRATIVE.some(w => lower.includes(w))) return null;
  // Any digit at all. Written-out small numbers ("two things") are fine and
  // carry no comp claim; digits are how a figure would actually appear.
  if (/\d/.test(t)) return null;
  // A stray percent or currency sign without digits still reads as a claim.
  if (/[%$€£]/.test(t)) return null;
  // Markdown or HTML would land raw in the email body.
  if (/[<>*_#`|]/.test(t)) return null;
  return t;
};
