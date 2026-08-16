import type postgres from 'postgres'

export type ToolCallOutcome<T = unknown> =
  | { status: 'fresh' }
  | { status: 'replayed'; result: T }
  | { status: 'ambiguous' }

type ToolCallRow = {
  status: 'pending' | 'done'
  result: unknown
}

/**
 * Writes the INTENT to call a tool before the tool runs. The caller must call
 * this, get `fresh`, and only then execute the tool — persisting intent before
 * effect is what makes a kill-and-resume safe to reason about.
 *
 * On replay:
 *  - done      -> return the stored result, do not execute
 *  - pending   -> the previous attempt died mid-side-effect. We cannot know
 *                 whether the external effect (email sent, booking link
 *                 tracked, ...) happened, so this is reported as `ambiguous`
 *                 rather than guessed as `fresh` (would re-send the email) or
 *                 `replayed` (would silently swallow a call that may never
 *                 have run). The caller escalates.
 */
export async function beginToolCall(
  sql: postgres.Sql,
  turnId: string,
  callId: string,
  name: string,
): Promise<ToolCallOutcome> {
  const inserted = await sql`
    insert into tool_calls (turn_id, call_id, name, status)
    values (${turnId}, ${callId}, ${name}, 'pending')
    on conflict (turn_id, call_id) do nothing
    returning call_id`
  if (inserted.length > 0) return { status: 'fresh' }

  const existing = await sql<ToolCallRow[]>`
    select status, result from tool_calls
     where turn_id = ${turnId} and call_id = ${callId}`
  const row = existing[0]!
  if (row.status === 'done') return { status: 'replayed', result: row.result }
  return { status: 'ambiguous' }
}

/**
 * Marks a pending tool call as done and stores its result. Only ever reached
 * after `beginToolCall` returned `fresh` — a `done` row is reported as
 * `replayed` and the caller never executes the tool a second time, so the
 * `and status = 'pending'` guard keeps a duplicate `finishToolCall` call from
 * silently overwriting a previously-stored result.
 *
 * Verifies its own effect like every other writer in this directory
 * (`claimTurn`, `saveTurnState`, `heartbeat`, `completeTurn`, `failTurn`,
 * `recordSpend`): zero rows back means the `(turnId, callId)` pair was never
 * begun (or was already finished), which would otherwise leave a `pending`
 * row stuck forever and every later replay silently reporting `ambiguous`
 * with no explanation in the system.
 */
export async function finishToolCall(
  sql: postgres.Sql,
  turnId: string,
  callId: string,
  result: unknown,
): Promise<void> {
  const rows = await sql`
    update tool_calls set status = 'done', result = ${sql.json(result as never)}
     where turn_id = ${turnId} and call_id = ${callId} and status = 'pending'
    returning call_id`
  if (rows.length === 0) {
    throw new Error(
      `finishToolCall: no pending tool_calls row for turn ${turnId}, call ${callId}`,
    )
  }
}
