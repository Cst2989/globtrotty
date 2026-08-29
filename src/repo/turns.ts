import type postgres from 'postgres'
import type { FailReason } from '../engine.js'

export type TurnInput = {
  turnId: string
  conversationId: string
  userId: string
  message: string
}

/**
 * The turn row plus the message that turn was queued for. Returns null for a
 * turn that does not exist or has already run, so a duplicate invocation is a
 * quiet no-op rather than a second run.
 *
 * The join is on `m.turn_id = t.id`, which is why lesson 2.1 writes the turn row
 * first and stamps the message with it. The tempting join, on the conversation
 * with `order by m.created_at desc limit 1`, answers a different question: it
 * returns the newest thing she has said on the conversation, which from lesson
 * 2.7 on can be a message she typed while this turn was already queued. The
 * worker would then run "two, and I forgot the crib" against a turn opened for
 * "one". Inside one transaction that `order by` is not even stable, because
 * every row shares one transaction_timestamp().
 */
export async function loadTurnInput(sql: postgres.Sql, turnId: string): Promise<TurnInput | null> {
  const rows = await sql`
    select t.id, t.conversation_id, t.user_id, m.content
      from course.turns t
      join course.messages m on m.turn_id = t.id and m.role = 'user'
     where t.id = ${turnId} and t.status = 'queued'`
  const row = rows[0]
  if (!row) return null
  return {
    turnId: row.id as string,
    conversationId: row.conversation_id as string,
    userId: row.user_id as string,
    message: row.content as string,
  }
}

/**
 * Writes the answer and closes the turn. Two statements in one transaction, so a
 * crash between them cannot leave a finished turn with no reply. Lesson 3.3
 * takes this much further; the transaction is the part that matters today.
 *
 * `failReason`, when passed, is written to `turns.fail_reason`: every outcome
 * the engine can record (src/engine.ts's `FAIL_REASONS`) carries its own
 * reason here, not just a capped turn. Only `'limit_reached'` also moves the
 * conversation off `'active'`, because it is the one reason tier 2 already
 * has its own status for (src/handler.ts sets `conversations.status =
 * 'limit_reached'` on its own denial, with no turn row at all); the others
 * are a turn ending without a real answer, which module 3's retry handles,
 * not a state the conversation itself needs to reflect yet.
 */
export async function finishTurn(
  sql: postgres.Sql,
  input: TurnInput,
  reply: string,
  failReason?: FailReason,
): Promise<void> {
  const status = failReason === 'limit_reached' ? 'limit_reached' : 'active'
  await sql.begin(async (tx) => {
    // An empty reply is not a message: it would render as a blank bubble in
    // her thread, which reads as worse than no reply at all. A capped turn
    // no longer hits this (src/limit-message.ts gives it a real sentence on
    // both tiers); step_cap and deadline_exceeded still finish with '' until
    // they earn a sentence of their own, and this is where that empty text
    // stops rather than becoming a row.
    if (reply !== '') {
      await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
               values (${input.conversationId}, ${input.userId}, ${input.turnId}, 'agent', ${reply})`
    }
    // Every turn this module closes ends 'done', with `fail_reason` beside it
    // naming why when there was one; `'failed'` in turns_status_check is
    // reserved for module 3's crash handling, not written here yet.
    await tx`update course.turns set status = 'done', finished_at = now(), fail_reason = ${failReason ?? null}
              where id = ${input.turnId}`
    await tx`update course.conversations set status = ${status}, updated_at = now()
              where id = ${input.conversationId} and user_id = ${input.userId}`
  })
}
