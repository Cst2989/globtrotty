import type postgres from 'postgres'
import { GATE_NAMES, type GateName } from '../gates/types.js'
import type { ScorecardRow } from './scorecard.js'

export type GateMetric = { gate: GateName; passed: number; failed: number; notEvaluated: number }

/**
 * How often each gate fired, over every gate run this user's conversations
 * produced. This is the question migration 0012's own header says the table was
 * created for, and until this lesson nothing asked it.
 *
 * Scoped to one user id, because an eval run mints its own and a global count
 * would sum the reader's own trips, the demo script's rows and every eval run
 * since the database was created into one meaningless number.
 *
 * Every gate in GATE_NAMES gets a row whether or not the table holds one for
 * it, and a gate with no rows reads as zero of zero rather than being absent.
 * A missing row and a zero row are different facts, and a scorecard that
 * printed only what it found would quietly stop mentioning a gate that stopped
 * running.
 */
export async function gateMetrics(
  sql: postgres.Sql, args: { userId: string },
): Promise<GateMetric[]> {
  const rows = await sql<{ gate: string; passed: boolean | null; n: number }[]>`
    select gate, passed, count(*)::int as n
      from course.gate_results
     where user_id = ${args.userId}
     group by gate, passed`
  return GATE_NAMES.map((gate) => {
    const mine = rows.filter((r) => r.gate === gate)
    const count = (passed: boolean | null) =>
      mine.filter((r) => r.passed === passed).reduce((sum, r) => sum + r.n, 0)
    return { gate, passed: count(true), failed: count(false), notEvaluated: count(null) }
  })
}

/** The same numbers as scorecard rows, so one renderer prints both halves of the card. */
export function gateRows(metrics: GateMetric[]): ScorecardRow[] {
  return metrics.map((m) => ({
    name: `gate:${m.gate}`,
    tally: { passed: m.passed, failed: m.failed, notEvaluated: m.notEvaluated },
  }))
}
