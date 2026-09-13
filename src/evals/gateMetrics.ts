import type postgres from 'postgres'
import { GATE_NAMES, type GateName } from '../gates/types.js'
import type { ScorecardRow } from './scorecard.js'

/**
 * The catch-all row, for gate names `course.gate_results` accepts and
 * `GATE_NAMES` does not.
 *
 * Migration 0012's check constraint accepts `'reviewer'` and this list
 * deliberately does not carry it, because a reviewer needs a model and
 * `GateName` is what stops the pipeline recording a row claiming one ran. So
 * the table can legally hold a name this file cannot place, and the choice is
 * between counting it somewhere and counting it nowhere. Nowhere is the option
 * this file's own argument rules out.
 */
export const OTHER_GATES = 'other'

export type GateMetric = {
  gate: GateName | typeof OTHER_GATES
  passed: number; failed: number; notEvaluated: number
}

/**
 * How often each gate fired in PRODUCTION, over this user's conversations. This
 * is the question migration 0012's own header says the table was created for,
 * and until this lesson nothing asked it.
 *
 * Scoped to one user id, because an eval run mints its own and a global count
 * would sum the reader's own trips, the demo script's rows and every eval run
 * since the database was created into one meaningless number.
 *
 * ## Which rows count, and why the replays do not
 *
 * `round = 0 and proposal_id is null` is what a production gate run looks like,
 * by construction: `runGates` defaults both (src/gates/pipeline.ts) and
 * `proposalRunner` records the proposal AFTER the gates return, so at the
 * moment they run there is no id to name. `replayGates` is the only writer that
 * passes either, at round 1 for a snapshot replay and round 2 for a live one
 * (REPLAY_ROUNDS, src/evals/replay.ts).
 *
 * Both predicates are here and one would have done, on purpose. Without them,
 * from the lesson that drives a conversation and then replays it, every gate
 * contributes TWO counts per proposal and `gate:budget 2/2` for one proposal is
 * not what "how often each gate fired" means to a reader. Worse, the live
 * replay is wrong ON PURPOSE, so a metric that counted it would be a number a
 * deliberately wrong answer moves. The second predicate is the lock: a future
 * writer that runs the production gates with a proposal id already in hand
 * would still be excluded rather than silently doubling every count.
 *
 * ## Which rows are named, and why a zero is printed
 *
 * Every gate in GATE_NAMES gets a row whether or not the table holds one for
 * it, and a gate with no rows reads as zero of zero rather than being absent.
 * A missing row and a zero row are different facts, and a scorecard that
 * printed only what it found would quietly stop mentioning a gate that stopped
 * running.
 *
 * `OTHER_GATES` is the exception and appears ONLY when such rows exist, because
 * it names no gate: a permanent `gate:other 0/0` says nothing about anything,
 * while a `gate:other` that appears at all says the table is holding a verdict
 * this file cannot place and somebody should look.
 */
export async function gateMetrics(
  sql: postgres.Sql, args: { userId: string },
): Promise<GateMetric[]> {
  const rows = await sql<{ gate: string; passed: boolean | null; n: number }[]>`
    select gate, passed, count(*)::int as n
      from course.gate_results
     where user_id = ${args.userId}
       and round = 0
       and proposal_id is null
     group by gate, passed`
  type Group = { gate: string; passed: boolean | null; n: number }
  const count = (of: readonly Group[], passed: boolean | null) =>
    of.filter((r) => r.passed === passed).reduce((sum, r) => sum + r.n, 0)

  const named = new Set<string>(GATE_NAMES)
  const metrics: GateMetric[] = GATE_NAMES.map((gate) => {
    const mine = rows.filter((r) => r.gate === gate)
    return { gate, passed: count(mine, true), failed: count(mine, false), notEvaluated: count(mine, null) }
  })
  const unplaced = rows.filter((r) => !named.has(r.gate))
  if (unplaced.length > 0) {
    metrics.push({
      gate: OTHER_GATES,
      passed: count(unplaced, true),
      failed: count(unplaced, false),
      notEvaluated: count(unplaced, null),
    })
  }
  return metrics
}

/** The same numbers as scorecard rows, so one renderer prints both halves of the card. */
export function gateRows(metrics: GateMetric[]): ScorecardRow[] {
  return metrics.map((m) => ({
    name: `gate:${m.gate}`,
    tally: { passed: m.passed, failed: m.failed, notEvaluated: m.notEvaluated },
  }))
}
