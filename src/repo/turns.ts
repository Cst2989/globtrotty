import type postgres from 'postgres'

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
 */
export async function finishTurn(
  sql: postgres.Sql,
  input: TurnInput,
  reply: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
             values (${input.conversationId}, ${input.userId}, ${input.turnId}, 'agent', ${reply})`
    await tx`update course.turns set status = 'done', finished_at = now() where id = ${input.turnId}`
    await tx`update course.conversations set status = 'active', updated_at = now()
              where id = ${input.conversationId} and user_id = ${input.userId}`
  })
}
