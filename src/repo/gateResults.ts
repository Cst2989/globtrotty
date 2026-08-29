import type postgres from 'postgres'
import type { GateName } from '../gates/types.js'

/**
 * `passed` is `boolean | null`, and the third state is load-bearing:
 *
 *  - `true`  — the gate ran and was satisfied.
 *  - `false` — the gate ran and rejected the proposal.
 *  - `null`  — the gate could not reach a verdict because a prerequisite gate
 *              already failed. A mixed-currency proposal has no trip total, so
 *              the totals gate produced nothing and the budget gate had nothing
 *              to compare against. `true` there would assert a total was
 *              computed and checked when none exists; omitting the row entirely
 *              would be indistinguishable from "we forgot to run the gate".
 *
 * (Migration 0005 dropped the `not null` on this column for exactly this.)
 */
export type GateResultRow = {
  gate: GateName | 'reviewer'
  passed: boolean | null
  detail: string | null
  sourceIds: string[]
}

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
