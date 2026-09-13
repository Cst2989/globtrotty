import type postgres from 'postgres'
import { constraintsFromNotebook } from '../gates/notebookConstraints.js'
import { runGates } from '../gates/pipeline.js'
import { GATE_NAMES, type GateName, type GateOutcome } from '../gates/types.js'
import { loadNotebook } from '../repo/notebook.js'
import { loadProposal } from '../repo/proposals.js'

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
  return { outcome, verdicts: await verdictsFor(sql, args.proposalId, round), against }
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
 * is not done here because nothing replays one proposal twice in one mode, so
 * the guard would be untested code standing in for a case no caller produces.
 *
 * `recordGateResults` only accepts a `GateName`, so the filter below can never
 * drop a row today. It is here because the column is text, and `gateMetrics`
 * carries the same guard for the same reason.
 */
async function verdictsFor(
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
