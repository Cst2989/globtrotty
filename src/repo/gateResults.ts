import type postgres from 'postgres'
import type { GateName } from '../gates/types.js'

/**
 * A gate outcome as a row. Deliberately a DISCRIMINATED UNION rather than
 * `{ passed: boolean | null; detail: string | null }`, because the two fields
 * are not independent and the flat shape lets the two combinations that are
 * lies typecheck:
 *
 *  - `passed: true` with a `detail`. A pass that also explains itself is a
 *    contradiction, and the explanation is the part a reader would believe.
 *  - `passed: null` with NO detail. This is the one that matters. `null` has
 *    more than one cause, and "the total could not be computed" and "no budget
 *    was ever configured" are different facts about the world, so a null that
 *    does not say which is a row nobody can act on. Requiring `detail: string`
 *    on this arm makes forgetting the reason a compile error rather than a
 *    convention held up by a code comment.
 *
 * `GateColumn` is wider than `GateName` by one value. `course.gate_results.gate`
 * accepts 'reviewer' (migration 0012) and `GateName` does not, so a reviewer
 * could write here without a migration, and the pipeline cannot write a row
 * claiming a reviewer ran. Nothing writes such a row yet. The seat exists from
 * lesson 6.6 and the judge on it (src/evals/judge.ts) records its verdicts on
 * the scorecard rather than in this table, because a judge's answer is not a
 * gate's and a gate row is the one thing the cashier reads.
 */
type GateColumn = GateName | 'reviewer'
export type GateResultRow =
  | { gate: GateColumn; passed: true;  detail: null;   sourceIds: string[] }
  | { gate: GateColumn; passed: false; detail: string; sourceIds: string[] }
  | { gate: GateColumn; passed: null;  detail: string; sourceIds: string[] }

/**
 * Writes every gate outcome, passes as well as failures. A table holding only
 * failures cannot answer "how often did freshness fire?", which is the first
 * question module 6 asks of this data.
 *
 * One multi-row insert rather than a loop: the pipeline writes seven rows per
 * proposal and a per-row round trip is seven network hops inside a turn already
 * being timed against a heartbeat. It is also one statement, so a partial set
 * of rows cannot be left behind by a mid-loop failure.
 *
 * Not fenced on the claim, unlike every writer in src/repo/turns.ts. A gate row
 * is an observation and not a state transition: a superseded worker that
 * manages to write one has recorded something true about a proposal it really
 * did judge, and the row carries its own turn_id, so nothing downstream is
 * confused by it. Fencing it would also mean threading a Claim through the
 * whole gate stack for no property anyone needs.
 *
 * The count is verified through `returning`, like every other writer on this
 * branch: a seven-gate run that recorded six rows is a gate run with one
 * verdict silently missing, and "no row" is exactly what this table uses to
 * mean "the gate never ran".
 */
export async function recordGateResults(
  sql: postgres.Sql,
  args: {
    conversationId: string
    userId: string
    turnId: string | null
    proposalId: string | null
    round: number
    results: GateResultRow[]
  },
): Promise<void> {
  if (args.results.length === 0) return
  const rows = args.results.map((r) => ({
    conversation_id: args.conversationId,
    user_id: args.userId,
    turn_id: args.turnId,
    proposal_id: args.proposalId,
    round: args.round,
    gate: r.gate,
    passed: r.passed,
    detail: r.detail,
    source_ids: r.sourceIds,
  }))
  const out = await sql`insert into course.gate_results ${sql(rows)} returning id`
  if (out.length !== rows.length) {
    throw new Error(`recordGateResults: wrote ${out.length} of ${rows.length} rows`)
  }
}
