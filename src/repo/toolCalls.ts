import type postgres from 'postgres'
import { FencedError, type Claim } from './turns.js'

export type ToolCallOutcome<T = unknown> =
  | { status: 'fresh' }
  | { status: 'replayed'; result: T }
  | { status: 'ambiguous' }

type ToolCallRow = { status: 'pending' | 'done'; name: string; result: unknown }

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
 * Carries the fencing token like every write in src/repo/turns.ts: the insert
 * only lands `where exists` a `course.turns` row that still has this claim's
 * `attempts` and is still `running`. Two lessons were spent making `attempts`
 * the value every write from this turn must carry to prove it comes from the
 * run that currently owns the row, and the ledger is a write like any other;
 * a worker the lease or the sweeper has already superseded must not be able
 * to write intent for a turn it no longer owns. A zero-row insert that ALSO
 * finds no existing row for this call is exactly that case (the plain insert
 * would otherwise have succeeded), and it throws FencedError rather than
 * quietly reporting `fresh` for a turn this worker no longer holds.
 *
 * On a replay, the stored `name` is compared against the name this call was
 * made with. Position (`callId`) identifies a call only while a resumed turn
 * asks the same questions in the same order; `turn()` re-runs `classify` on
 * every resume (src/conversation.ts) and can reach a different desk with a
 * different tool set, so a position id alone would hand a resumed call
 * another call's stored result. A name mismatch throws rather than guessing
 * which of the two calls is the real one.
 *
 * With the name confirmed:
 *  - done      the stored result comes back and the tool is not run.
 *  - pending   the previous attempt died between this row and its result. We
 *              cannot know whether the outside world changed (a supplier hold
 *              placed, an email sent), so this is reported as `ambiguous` rather
 *              than guessed as `fresh`, which would do it twice, or as
 *              `replayed`, which would invent a result for a call that may never
 *              have run. The caller escalates.
 *
 * `ambiguous` is currently terminal for the turn: nothing in this module ever
 * clears a pending row, and `finishToolCall` below only ever closes one from
 * a fresh `beginToolCall`, not from outside. Clearing a stuck row is a
 * person's job: read `select * from course.tool_calls where status =
 * 'pending'` (joined to `course.turns` for the turn's own state), decide from
 * the tool's own record whether the call actually landed, and delete the row
 * by hand once that is known. Lesson 3.5's sweeper is expected to name this as
 * the operator step for a turn that failed `ambiguous_tool_call`, not to
 * resolve it on its own.
 *
 * `on conflict do nothing` plus a read-back rather than a read and then an
 * insert: the read-then-write has a gap, and two workers in that gap both
 * conclude the call is fresh. `test/tool-calls.test.ts`'s real-pool test
 * proves exactly one of two concurrent callers gets `fresh`.
 */
export async function beginToolCall(
  sql: postgres.Sql,
  claim: Claim,
  callId: string,
  name: string,
): Promise<ToolCallOutcome> {
  const inserted = await sql`
    insert into course.tool_calls (turn_id, call_id, name, status)
    select ${claim.turnId}, ${callId}, ${name}, 'pending'
     where exists (select 1 from course.turns
                    where id = ${claim.turnId}
                      and attempts = ${claim.attempts}
                      and status = 'running')
    on conflict (turn_id, call_id) do nothing
    returning call_id`
  if (inserted.length > 0) return { status: 'fresh' }

  const existing = await sql<ToolCallRow[]>`
    select status, name, result from course.tool_calls
     where turn_id = ${claim.turnId} and call_id = ${callId}`
  const row = existing[0]
  // No row and no insert: the only way the insert above can match zero rows
  // without a conflict is the `exists` clause failing, which means this
  // worker no longer owns the turn.
  if (!row) throw new FencedError(claim.turnId)
  if (row.name !== name) {
    // A resumed turn asked a different question at the same position, which
    // is what a changed classification looks like from here. Handing back the
    // other call's result would be silently wrong, so this is a hard error
    // rather than a third ToolCallOutcome case: nothing downstream should ever
    // be built to cope with it as a normal outcome.
    throw new Error(
      `beginToolCall: ${callId} was recorded as ${row.name}, not ${name}; a resumed turn must not replay another call's result`,
    )
  }
  if (row.status === 'done') return { status: 'replayed', result: row.result }
  return { status: 'ambiguous' }
}

/**
 * Records the result and closes the call. Only ever reached after `fresh`, so
 * the `and status = 'pending'` guard is not defensive noise: without it a second
 * finish would overwrite a result an earlier run already handed to the model.
 *
 * Carries the fencing token on its own `where` too, for the same reason
 * `beginToolCall` does: a worker that lost its claim between writing intent
 * and finishing the call must not be the one who gets to say how it ended.
 *
 * Verifies its own effect, like every writer in this directory. Zero rows
 * back means one of three things: the pair was never begun, it is already
 * done, or this worker no longer owns the turn. All three throw, because in
 * every case something already knows more about this call than the caller
 * does, and swallowing the mismatch would leave a `pending` row stuck with
 * nothing in the system saying why. `ledgerRunner` (src/tools.ts) is what
 * turns this throw into the turn's own `ambiguous_tool_call` ending: the tool
 * already ran and could not be recorded, which is the ambiguous case by
 * definition.
 */
export async function finishToolCall(
  sql: postgres.Sql,
  claim: Claim,
  callId: string,
  result: unknown,
): Promise<void> {
  const rows = await sql`
    update course.tool_calls set status = 'done', result = ${sql.json(result as never)}
     where turn_id = ${claim.turnId} and call_id = ${callId} and status = 'pending'
       and exists (select 1 from course.turns
                    where id = ${claim.turnId}
                      and attempts = ${claim.attempts}
                      and status = 'running')
    returning call_id`
  if (rows.length === 0) {
    throw new Error(
      `finishToolCall: no pending course.tool_calls row for turn ${claim.turnId}, call ${callId} ` +
      '(never begun, already done, or this worker no longer owns the turn)',
    )
  }
}
