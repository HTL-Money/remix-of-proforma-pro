export const meta = {
  name: 'compacting-fanout',
  description: 'Template: fan out over a work-list with compaction between every stage',
  whenToUse: 'Copy this when a task needs many agents. It keeps token cost flat as the work-list grows.',
  phases: [
    { title: 'Scan', detail: 'each item examined; returns a bounded digest, never raw text' },
    { title: 'Verify', detail: 'only fresh, deduped findings are verified' },
    { title: 'Synthesize', detail: 'one pass over digests' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Why this file exists
//
// A fan-out workflow burns tokens in three places, and none of them are the
// work itself:
//
//   1. Agents returning prose. A subagent asked for "findings" will happily
//      return three paragraphs per finding, and every downstream stage pays for
//      all of it, forever.
//   2. Re-verifying what a previous round already judged.
//   3. Running more rounds after the results have gone dry.
//
// The fix is compaction *between* stages: every agent returns a schema-bounded
// digest, the orchestrator dedupes against everything already seen, and a
// budget guard stops the loop before it spends money on nothing. This is
// deterministic JS in the script — not a request in a prompt — so it cannot be
// ignored by an agent having an expansive day.
// ─────────────────────────────────────────────────────────────────────────────

// Bounded schemas are the single biggest saver: maxLength on strings caps what
// any one agent can hand back, so cost per item has a ceiling you chose.
const DIGEST = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 8,                       // a finder that "found 200 things" is noise
      items: {
        type: 'object',
        required: ['key', 'claim', 'severity'],
        properties: {
          key: { type: 'string', maxLength: 60 },       // dedupe identity
          claim: { type: 'string', maxLength: 220 },    // one sentence, not a paragraph
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          where: { type: 'string', maxLength: 120 },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['stands', 'why'],
  properties: { stands: { type: 'boolean' }, why: { type: 'string', maxLength: 220 } },
}

// Reserve enough headroom to finish the synthesis stage after the loop stops.
// Without this the budget is spent on discovery and there is nothing left to
// turn it into an answer.
const RESERVE = 60_000

const TARGETS = Array.isArray(args?.targets) ? args.targets : []
const GOAL = args?.goal ?? 'defects a reviewer would insist on fixing'
if (!TARGETS.length) return { error: 'pass { goal, targets: [...] } as args' }

const affordable = (need = RESERVE) =>
  !budget.total || budget.remaining() > need

const seen = new Set()
const confirmed = []
let dryRounds = 0

phase('Scan')
for (let round = 1; dryRounds < 2 && round <= 4; round++) {
  if (!affordable(RESERVE * 2)) { log(`budget guard: stopping before round ${round}`); break }

  // Stage 1 returns digests. Stage 2 sees only the deduped remainder, so the
  // verify cost tracks *new* findings, not cumulative ones.
  const rounds = await pipeline(
    TARGETS,
    (t, _orig, i) => agent(
      `Examine ${typeof t === 'string' ? t : JSON.stringify(t)} for: ${GOAL}.\n` +
      `Round ${round}. Already reported (do not repeat): ${[...seen].slice(-40).join('; ') || 'nothing yet'}.\n` +
      `Return at most 8 items. One sentence per claim — no preamble, no restating the file.`,
      { label: `scan:${i}`, phase: 'Scan', schema: DIGEST },
    ),
    async (digest, t, i) => {
      if (!digest?.items?.length) return []
      // Dedupe in plain code against everything ever seen — not against the
      // confirmed list, or rejected findings resurface every round and the
      // loop never converges.
      const fresh = digest.items.filter(it => it.key && !seen.has(it.key))
      fresh.forEach(it => seen.add(it.key))
      if (!fresh.length || !affordable()) return []
      return parallel(fresh.map(it => () =>
        agent(
          `Try to REFUTE this claim about ${typeof t === 'string' ? t : 'the target'}: "${it.claim}"` +
          (it.where ? ` (at ${it.where})` : '') +
          `\nDefault to stands=false if you cannot demonstrate it concretely. One sentence.`,
          { label: `verify:${it.key.slice(0, 28)}`, phase: 'Verify', schema: VERDICT },
        ).then(v => (v?.stands ? { ...it, why: v.why } : null)),
      ))
    },
  )

  const kept = rounds.flat().filter(Boolean)
  confirmed.push(...kept)
  log(`round ${round}: ${kept.length} confirmed · ${seen.size} seen · ${Math.round(budget.spent() / 1000)}k spent`)
  dryRounds = kept.length ? 0 : dryRounds + 1
}

phase('Synthesize')
// The synthesizer reads digests, never transcripts. That is the whole point:
// this prompt is the same size whether the scan covered 5 targets or 500.
const brief = confirmed
  .sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity))
  .map(f => `[${f.severity}] ${f.claim}${f.where ? ` (${f.where})` : ''} — survived refutation: ${f.why}`)
  .join('\n')

const summary = confirmed.length && affordable(0)
  ? await agent(
      `These findings survived adversarial verification for: ${GOAL}\n\n${brief}\n\n` +
      `Give the shortest useful account: what actually matters, what to fix first, and anything the set implies as a pattern.`,
      { label: 'synthesize', phase: 'Synthesize' },
    )
  : null

return {
  confirmed,
  summary,
  spentTokens: budget.spent(),
  coverage: { targets: TARGETS.length, distinctFindings: seen.size, dryRounds },
}
