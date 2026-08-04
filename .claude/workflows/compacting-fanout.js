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
      maxItems: 6,  // a finder that "found 200 things" is noise
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

// `args` is documented to arrive as a real JSON value, but a caller that
// stringifies it is a common enough mistake that failing on it wastes a whole
// launch — the first run of this file died in 30ms for exactly that reason.
// Coerce instead, and say so, rather than making the caller guess.
const input = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return null } })()
  : args
if (typeof args === 'string' && input) log('args arrived JSON-encoded; parsed it')

const TARGETS = Array.isArray(input?.targets) ? input.targets : []
const GOAL = input?.goal ?? 'defects a reviewer would insist on fixing'
if (!TARGETS.length) return { error: 'pass { goal, targets: [...] } as args — got: ' + JSON.stringify(args)?.slice(0, 200) }

// A budget guard alone is NOT a guard. `budget.total` is null unless the user
// set an explicit token target, and `budget.remaining()` is then Infinity — so
// on the first real run of this file every check passed and it spent 100 agents
// and 4M tokens across 65 minutes on a three-target review. The absolute caps
// below hold regardless of whether a budget exists; the budget check only
// tightens them. Raise maxAgents deliberately, per task, in the caller's args.
const MAX_AGENTS = Number(input?.maxAgents) || 15
const MAX_ROUNDS = Number(input?.maxRounds) || 2
const MAX_ITEMS_PER_TARGET = Number(input?.maxItemsPerTarget) || 3 // the multiplier: items x targets x rounds
let spawned = 0

// Hold one slot back for the synthesizer. Without this a cap-filling scan
// starves the one stage that turns findings into an answer — the dry run spent
// exactly 15 of 15 on discovery and produced no summary at all.
const LOOP_CAP = Math.max(1, MAX_AGENTS - 1)

/** True only if BOTH the agent cap and (when one exists) the token budget allow
 *  another `want` agents. `cap` is LOOP_CAP during discovery, MAX_AGENTS for
 *  the reserved synthesis slot. */
const affordable = (want = 1, need = RESERVE, cap = LOOP_CAP) =>
  spawned + want <= cap && (!budget.total || budget.remaining() > need)

const seen = new Set()
const confirmed = []
let dryRounds = 0

// Each target costs one scan plus up to MAX_ITEMS_PER_TARGET verifies, so this
// is how many targets a round can actually afford.
const perTarget = 1 + MAX_ITEMS_PER_TARGET
const covered = new Set()

phase('Scan')
for (let round = 1; dryRounds < 2 && round <= MAX_ROUNDS; round++) {
  const slots = LOOP_CAP - spawned
  if (slots < perTarget || (budget.total && budget.remaining() < RESERVE * 2)) {
    log(`guard: stopping before round ${round} (${spawned}/${LOOP_CAP} discovery agents spent)`)
    break
  }
  // Take as many targets as the remaining slots afford instead of refusing to
  // start: a 40-item work-list under a cap of 15 used to return nothing at all.
  // Round 2 picks up where round 1 stopped, and anything never reached is
  // reported in `coverage` rather than passed off as "clean".
  const batch = TARGETS.filter(t => !covered.has(t)).slice(0, Math.floor(slots / perTarget))
  if (!batch.length) { log(`guard: no affordable targets left before round ${round}`); break }
  batch.forEach(t => covered.add(t))
  if (batch.length < TARGETS.length) log(`round ${round}: ${batch.length} of ${TARGETS.length} targets this round`)

  // Stage 1 returns digests. Stage 2 sees only the deduped remainder, so the
  // verify cost tracks *new* findings, not cumulative ones.
  const rounds = await pipeline(
    batch,
    (t, _orig, i) => {
      spawned++
      return agent(
        `Examine ${typeof t === 'string' ? t : JSON.stringify(t)} for: ${GOAL}.\n` +
        `Round ${round}. Already reported (do not repeat): ${[...seen].slice(-40).join('; ') || 'nothing yet'}.\n` +
        `Return at most ${MAX_ITEMS_PER_TARGET} items — only the ones you would stake your name on. ` +
        `One sentence per claim; no preamble, no restating the file.`,
        { label: `scan:${i}`, phase: 'Scan', schema: DIGEST },
      )
    },
    async (digest, t, i) => {
      if (!digest?.items?.length) return []
      // Dedupe in plain code against everything ever seen — not against the
      // confirmed list, or rejected findings resurface every round and the
      // loop never converges.
      const all = digest.items.filter(it => it.key && !seen.has(it.key))
      all.forEach(it => seen.add(it.key))
      // Truncate to the cap and SAY what was dropped: a silent cut reads as
      // "nothing else was there".
      const fresh = all.slice(0, MAX_ITEMS_PER_TARGET)
      if (all.length > fresh.length) log(`scan:${i} returned ${all.length}; verifying ${fresh.length}, dropped ${all.length - fresh.length}`)
      if (!fresh.length || !affordable(fresh.length)) {
        if (fresh.length) log(`guard: skipping ${fresh.length} verifies for scan:${i}`)
        return []
      }
      spawned += fresh.length
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

const summary = confirmed.length && affordable(1, 0, MAX_AGENTS)
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
  coverage: {
    targets: TARGETS.length,
    targetsExamined: covered.size,
    targetsNotReached: TARGETS.filter(t => !covered.has(t)),   // never silently imply "clean"
    distinctFindings: seen.size,
    dryRounds,
    agentsSpawned: spawned,
    agentCap: MAX_AGENTS,
  },
}
