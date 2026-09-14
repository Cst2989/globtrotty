import type postgres from 'postgres'
import { constraintsFromNotebook } from '../gates/notebookConstraints.js'
import { runGates } from '../gates/pipeline.js'
import { GATE_NAMES, type GateName, type GateOutcome, type Violation } from '../gates/types.js'
import { loadNotebook } from '../repo/notebook.js'
import { rehydrateRefs } from '../gates/rehydrateGate.js'
import { sumMoney } from '../money.js'
import { loadProposal, type Proposal } from '../repo/proposals.js'

/**
 * One gate's recorded verdict, in the three values `course.gate_results` holds:
 * true is the gate ran and was satisfied, false is it ran and rejected, and
 * null is it could not reach a verdict and `detail` says why.
 *
 * `detail` is null only on a pass, because a gate that had nothing to say says
 * nothing. On a false it is every violation that gate filed, and on a null it
 * is one of `NOT_EVALUATED`'s reasons (src/gates/pipeline.ts).
 */
export type GateVerdict = { passed: boolean | null; detail: string | null }

/**
 * Every gate this replay recorded, by name. `Partial`, because a run that fails
 * provenance short-circuits and writes rows for the gates that spoke and no
 * others, so an absent gate is "no row", which is a third thing again and must
 * not be read as a pass.
 */
export type GateVerdicts = Partial<Record<GateName, GateVerdict>>

export type ReplayResult = {
  outcome: GateOutcome
  /**
   * The per-gate verdicts, read back out of `course.gate_results` after the
   * write, rather than derived from `outcome`.
   *
   * `GateOutcome` carries `ok` and a violation list and nothing else, so "no
   * budget violation" there covers two different facts: the budget gate ran and
   * was satisfied, and the budget gate had no budget to check against and
   * recorded `passed: null`. A grader reading the outcome alone reports both as
   * a pass, which is the fail-open collapse `Check.passed` (src/evals/grade.ts)
   * exists to refuse. The table already distinguishes them, so this reads the
   * table.
   */
  verdicts: GateVerdicts
  against: 'snapshot' | 'live'
}

/**
 * Which round each replay mode writes under.
 *
 * Round 0 is production's verdict and neither of these DEFAULTS to it. That is
 * all this constant enforces: `replayGates` still takes `round?: number`, so a
 * caller may pass 0 and write one from here. Nothing is at risk if it does,
 * because such a row still carries a `proposal_id` and `gateMetrics`
 * (src/evals/gateMetrics.ts) excludes it on the second of its two predicates,
 * which is the case that predicate is there for.
 *
 * The two replay modes are separated because they disagree ON PURPOSE: run
 * against one proposal, the snapshot replay records what production decided and
 * the live replay records what her notebook would decide today. Two rows for
 * one gate at one round would be two answers to one question with nothing in
 * the table saying which is which, which is the exact indistinguishability this
 * file's round argument was introduced to prevent.
 */
export const REPLAY_ROUNDS = { snapshot: 1, live: 2 } as const

/**
 * Runs the gates again over a proposal that already exists, against the
 * notebook that proposal was judged with.
 *
 * `against: 'live'` exists so a lesson and a test can produce the wrong answer
 * on purpose and show what it looks like. It is never the default and no
 * production path passes it: reading the live notebook is what makes a replay
 * agree with whatever she believes today rather than with what we did. Its rows
 * are written under a round of their own and `gateMetrics`
 * (src/evals/gateMetrics.ts) counts neither replay, so a deliberately wrong
 * answer cannot reach a card.
 *
 * `proposalId` and `round` are passed through to `runGates`, which has accepted
 * both since lesson 4.5 and has never been given either, because
 * `proposalRunner` records the proposal AFTER the gates return. A replay runs
 * against a proposal that already exists, so it can name it, and
 * `gate_results_by_proposal` (migration 0013) finally indexes a column
 * something writes. The production path still writes null there and that is
 * correct: at the moment the production gates run, the row they would name does
 * not exist.
 *
 * `userId` is taken rather than read off the proposal, because every caller in
 * this module already has it and a signature that reads it from the row would
 * hide which user a replay is being run as. It is checked against the row
 * instead, so a disagreement is a sentence here rather than a foreign key
 * violation from two layers down.
 */
export async function replayGates(
  sql: postgres.Sql,
  args: {
    proposalId: string; conversationId: string; userId: string
    now: Date; today: string; round?: number; against?: 'snapshot' | 'live'
  },
): Promise<ReplayResult> {
  const proposal = await loadProposal(sql, args.proposalId, args.conversationId)
  if (!proposal) {
    throw new Error(`replayGates: no proposal ${args.proposalId} in conversation ${args.conversationId}`)
  }
  if (proposal.userId !== args.userId) {
    throw new Error(
      `replayGates: proposal ${args.proposalId} was judged for a different user than the one this `
      + 'replay names. Pass the id the proposal belongs to, or read it off the proposal row.',
    )
  }
  const against = args.against ?? 'snapshot'
  const nb = against === 'live'
    ? await loadNotebook(sql, args.conversationId, args.userId)
    : proposal.requirementsSnapshot
  if (!nb) {
    // Refused rather than fallen back to the live notebook. A fallback would
    // turn every pre-0018 row into a silently wrong pass, which is the failure
    // this file exists to remove, so the eval drops the case and the scorecard
    // counts it in `casesExpected` and not in `casesGraded`.
    throw new Error(
      `replayGates: proposal ${args.proposalId} was written before migration 0018 and carries `
      + 'no requirements snapshot. It cannot be replayed, and the live notebook is not a substitute.',
    )
  }
  const round = args.round ?? REPLAY_ROUNDS[against]
  const outcome = await runGates(sql, {
    conversationId: args.conversationId,
    userId: args.userId,
    turnId: proposal.turnId,
    refs: proposal.refs,
    notebook: constraintsFromNotebook(nb, args.today),
    now: args.now,
    proposalId: args.proposalId,
    round,
  })
  return { outcome, verdicts: await readGateVerdicts(sql, args.proposalId, round), against }
}

/**
 * Every row at `(proposal_id, round)`, by gate, which for one replay per mode is
 * the set that replay just wrote.
 *
 * It is not narrowed to this run, and the sentence above says so rather than
 * claiming otherwise. Ordered by `seq`, a bigint identity since migration 0012,
 * and written into the map in that order, so replaying one proposal twice in
 * one mode leaves the LATEST verdict for each gate standing rather than an
 * arbitrary one. The case that leaves behind is a second same-mode replay that
 * short-circuits on provenance and writes fewer rows: the older row for a gate
 * this run never reached would survive and be read as this run's. Narrowing to
 * the rows above the highest `seq` seen before the write would close it, and it
 * is not done here.
 *
 * What keeps that safe is that no caller replays one proposal twice in one
 * mode. Lesson 6.6's nightly judge would have been the first: a cron that
 * grades the newest hundred decided proposals every night replays each of them
 * in snapshot mode every night. `replayGatesOnce` below is what stops it being
 * one, by reading these rows first and running the gates only when there are
 * none, so that cron writes one round-1 row set per proposal ever rather than
 * one per night. The `seq` narrowing is still what a caller that genuinely
 * wants to replay twice in one mode would need first.
 *
 * `recordGateResults` only accepts a `GateName`, so the filter below can never
 * drop a row today. It is here because the column is text, and `gateMetrics`
 * carries the same guard for the same reason.
 */
export async function readGateVerdicts(
  sql: postgres.Sql, proposalId: string, round: number,
): Promise<GateVerdicts> {
  const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null }[]>`
    select gate, passed, detail from course.gate_results
     where proposal_id = ${proposalId} and round = ${round}
     order by seq`
  const known = new Set<string>(GATE_NAMES)
  const verdicts: GateVerdicts = {}
  for (const row of rows) {
    if (!known.has(row.gate)) continue
    verdicts[row.gate as GateName] = { passed: row.passed, detail: row.detail }
  }
  return verdicts
}

/**
 * The outcome to judge, with the gates run AT MOST ONCE per proposal per mode.
 *
 * `replayGates` above writes a `course.gate_results` row set on every call, and
 * `recordGateResults` is a plain insert with no upsert. One nightly caller that
 * grades the newest hundred decided proposals is therefore one hundred fresh
 * row sets a night, for ever, against real proposals, and the LATEST-wins
 * reasoning `readGateVerdicts` rests on would stop being safe on the second
 * night: a run that short-circuits on provenance writes fewer rows than the
 * night before, and the older row for a gate it never reached would be read as
 * this run's.
 *
 * So this reads first. When rows exist at that round the gates are not run
 * again: the verdicts come out of the table, and the items are rehydrated
 * read-only out of `course.tool_results`, which is the same corpus read
 * `runGates` would have made and the only part of it the judge needs.
 *
 * It is NOT a cache and must not be used where a fresh verdict is the point.
 * Lesson 6.2's demonstration calls `replayGates` directly for that reason: the
 * whole of that lesson is one proposal replayed against two different
 * notebooks, and a reader that skipped the second run would have nothing to
 * compare.
 */
export async function replayGatesOnce(
  sql: postgres.Sql,
  args: {
    proposalId: string; conversationId: string; userId: string
    now: Date; today: string; against?: 'snapshot' | 'live'
  },
): Promise<ReplayResult> {
  const against = args.against ?? 'snapshot'
  const recorded = await readGateVerdicts(sql, args.proposalId, REPLAY_ROUNDS[against])
  if (Object.keys(recorded).length === 0) return await replayGates(sql, { ...args, against })

  const proposal = await loadProposal(sql, args.proposalId, args.conversationId)
  if (!proposal) {
    throw new Error(`replayGatesOnce: no proposal ${args.proposalId} in conversation ${args.conversationId}`)
  }
  if (proposal.userId !== args.userId) {
    throw new Error(
      `replayGatesOnce: proposal ${args.proposalId} was judged for a different user than the one this `
      + 'replay names. Pass the id the proposal belongs to, or read it off the proposal row.',
    )
  }
  return { outcome: await recordedOutcome(sql, proposal, recorded), verdicts: recorded, against }
}

/**
 * The outcome the recorded rows already decided, rebuilt without writing one.
 *
 * A recorded `false` is a refusal and is returned as one, carrying the detail
 * the gate itself wrote rather than a sentence invented here. Only then are the
 * items read, because there is no point rehydrating a corpus for a proposal
 * nothing will judge.
 *
 * A round that recorded no `false` is treated as an approval even when it
 * recorded fewer rows than there are gates, which is the one thing this shares
 * with `runGates`: a short-circuited run writes rows for the gates that spoke,
 * and every gate that spoke was satisfied. `sumMoney` is what totals the items,
 * and it refuses to add two currencies, so a set the currency gate would have
 * rejected throws here rather than producing a total nobody should read.
 */
async function recordedOutcome(
  sql: postgres.Sql, proposal: Proposal, verdicts: GateVerdicts,
): Promise<GateOutcome> {
  const refused: Violation[] = (Object.entries(verdicts) as [GateName, GateVerdict][])
    .filter(([, v]) => v.passed === false)
    .map(([gate, v]) => ({
      gate,
      detail: v.detail ?? `The ${gate} gate is recorded as failed with no detail.`,
      sourceIds: [],
    }))
  if (refused.length > 0) return { ok: false, violations: refused }
  const hydrated = await rehydrateRefs(sql, proposal.conversationId, proposal.refs)
  if (!hydrated.ok) return { ok: false, violations: hydrated.violations }
  return {
    ok: true,
    items: hydrated.items,
    total: sumMoney(hydrated.items.map((i) => i.lineTotal)),
  }
}
