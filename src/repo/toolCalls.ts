import type postgres from 'postgres'

export type ToolCallOutcome<T = unknown> =
  | { status: 'fresh' }
  | { status: 'replayed'; result: T }
  | { status: 'ambiguous' }

type ToolCallRow = { status: 'pending' | 'done'; result: unknown }

/**
 * A tool call whose outcome we cannot know. Thrown rather than returned so it
 * cannot be mistaken for a tool result and fed back to the model: an ambiguous
 * call is a reason to stop the turn, not an answer to reason from.
 */
export class AmbiguousToolCallError extends Error {
  constructor(readonly callId: string, readonly name: string) {
    super(`Tool call ${callId} (${name}) was started and never finished; its effect is unknown`)
    this.name = 'AmbiguousToolCallError'
  }
}

/**
 * Writes the INTENT to call a tool, before the tool runs. The caller runs the
 * tool only on `fresh`. Persisting intent before effect is the entire mechanism:
 * without the pending row, a crash mid call is indistinguishable from a call
 * that never happened.
 *
 * On a replay:
 *  - done      the stored result comes back and the tool is not run.
 *  - pending   the previous attempt died between this row and its result. We
 *              cannot know whether the outside world changed (a supplier hold
 *              placed, an email sent), so this is reported as `ambiguous` rather
 *              than guessed as `fresh`, which would do it twice, or as
 *              `replayed`, which would invent a result for a call that may never
 *              have run. The caller escalates.
 *
 * `on conflict do nothing` plus a read-back rather than a read and then an
 * insert: the read-then-write has a gap, and two workers in that gap both
 * conclude the call is fresh.
 */
export async function beginToolCall(
  sql: postgres.Sql,
  turnId: string,
  callId: string,
  name: string,
): Promise<ToolCallOutcome> {
  const inserted = await sql`
    insert into course.tool_calls (turn_id, call_id, name, status)
    values (${turnId}, ${callId}, ${name}, 'pending')
    on conflict (turn_id, call_id) do nothing
    returning call_id`
  if (inserted.length > 0) return { status: 'fresh' }

  const existing = await sql<ToolCallRow[]>`
    select status, result from course.tool_calls
     where turn_id = ${turnId} and call_id = ${callId}`
  const row = existing[0]!
  if (row.status === 'done') return { status: 'replayed', result: row.result }
  return { status: 'ambiguous' }
}

/**
 * Records the result and closes the call. Only ever reached after `fresh`, so
 * the `and status = 'pending'` guard is not defensive noise: without it a second
 * finish would overwrite a result an earlier run already handed to the model.
 *
 * Verifies its own effect, like every writer in this directory. Zero rows back
 * means this pair was never begun or is already done, and swallowing that would
 * leave a `pending` row stuck forever, so every later replay of the turn reports
 * `ambiguous` with nothing in the system saying why.
 */
export async function finishToolCall(
  sql: postgres.Sql,
  turnId: string,
  callId: string,
  result: unknown,
): Promise<void> {
  const rows = await sql`
    update course.tool_calls set status = 'done', result = ${sql.json(result as never)}
     where turn_id = ${turnId} and call_id = ${callId} and status = 'pending'
    returning call_id`
  if (rows.length === 0) {
    throw new Error(`finishToolCall: no pending course.tool_calls row for turn ${turnId}, call ${callId}`)
  }
}
