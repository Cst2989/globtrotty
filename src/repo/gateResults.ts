import type postgres from 'postgres'
import type { GateName } from '../gates/types.js'

/**
 * A gate outcome as a row. Deliberately a DISCRIMINATED UNION rather than
 * `{passed: boolean | null; detail: string | null}`, because the two fields are
 * not independent and the flat shape lets the two combinations that are lies
 * type-check:
 *
 *  - `passed: true` with a `detail` — a pass that also explains itself is a
 *    contradiction, and the explanation is the part a reader would believe.
 *  - `passed: null` with NO detail. This is the one that matters. `null` has
 *    more than one cause — "the total could not be computed" and "no budget was
 *    ever configured" are different facts about the world — so a null that does
 *    not say which is a row nobody can act on. Requiring `detail: string` on
 *    this arm makes forgetting the reason a compile error rather than a
 *    convention held up by a code comment.
 *
 * The three verdicts:
 *
 *  - `true`  — the gate ran and was satisfied.
 *  - `false` — the gate ran and rejected the proposal.
 *  - `null`  — the gate could not reach a verdict, and `detail` says why.
 *
 * (Migration 0005 dropped the `not null` on the column for exactly this third
 * state; omitting the row instead would be indistinguishable from "we forgot to
 * run the gate".)
 */
type GateColumn = GateName | 'reviewer'
export type GateResultRow =
  | { gate: GateColumn; passed: true;  detail: null;   sourceIds: string[] }
  | { gate: GateColumn; passed: false; detail: string; sourceIds: string[] }
  | { gate: GateColumn; passed: null;  detail: string; sourceIds: string[] }

/**
 * Writes every gate outcome — passes as well as failures. A table holding only
 * failures cannot answer "how often did freshness fire?", which is the first
 * question slice 2 asks of this data.
 *
 * One multi-row insert rather than a loop: the pipeline writes seven rows per
 * proposal and a per-row round trip is seven network hops inside a turn that is
 * already being timed against a heartbeat. It is also one statement, so a
 * partial set of rows cannot be left behind by a mid-loop failure.
 */
export async function recordGateResults(
  sql: postgres.Sql,
  args: {
    conversationId: string
    turnId: string | null
    proposalId: string | null
    round: number
    results: GateResultRow[]
  },
): Promise<void> {
  if (args.results.length === 0) return
  const rows = args.results.map((r) => ({
    conversation_id: args.conversationId,
    turn_id: args.turnId,
    proposal_id: args.proposalId,
    round: args.round,
    gate: r.gate,
    passed: r.passed,
    detail: r.detail,
    source_ids: r.sourceIds,
  }))
  await sql`insert into gate_results ${sql(rows)}`
}

/** Points the gate rows of ONE round at the proposal they produced. Round-scoped: other rounds stay null. */
export async function attachProposal(
  sql: postgres.Sql, args: { turnId: string; round: number; proposalId: string },
): Promise<void> {
  await sql`update gate_results set proposal_id = ${args.proposalId}
             where turn_id = ${args.turnId} and round = ${args.round} and proposal_id is null`
}

/**
 * How many reviewer verdicts this turn has already recorded. Persisted before
 * any later step, so a crash cannot reset the round bound. Throws on a missing
 * row for the same reason `countPriorGateRuns` does.
 */
export async function countReviewerVerdicts(sql: postgres.Sql, turnId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from gate_results where turn_id = ${turnId} and gate = 'reviewer'`
  const row = rows[0]
  if (!row) throw new Error('countReviewerVerdicts: count returned no row; refusing to assume zero')
  return row.n
}
