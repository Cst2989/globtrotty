import type postgres from 'postgres'

export type SubmitDeps = {
  sql: postgres.Sql
  /** Starts the work. Injected, so tests never make an HTTP call. */
  invoke: (turnId: string) => Promise<void>
}

export type SubmitInput = {
  userId: string
  conversationId: string | null
  message: string
}

export type SubmitResult = {
  conversationId: string
  turnId: string
  status: 'queued'
}

/**
 * Tier 2: the synchronous handler. It accepts her message and returns fast,
 * doing no model work itself.
 *
 * The order of the writes is the whole lesson. Her message row and the turn row
 * are committed BEFORE `invoke` is ever called: the turn is already durable at
 * 'queued', so a worker that never starts leaves work that can still be picked
 * up. Reversed, invoking before the row is committed, a crash in between would
 * replay work with no durable record that it had started, which is the failure
 * module 1's crash test showed.
 *
 * The turn row goes in before the message row so the message can name the turn
 * it was queued for. Lesson 2.2's worker loads a turn's input by that id, and
 * "the newest message on this conversation" is a different fact: she can type
 * again while a turn is running, and the worker must still run the message it
 * was given, not the one that arrived after it.
 */
export async function submitMessage(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  const { sql } = deps

  const conversationId = input.conversationId ?? (
    await sql`insert into course.conversations (user_id) values (${input.userId}) returning id`
  )[0]!.id as string

  const inserted = await sql`
    insert into course.turns (conversation_id, user_id) values (${conversationId}, ${input.userId})
    returning id`
  const turnId = inserted[0]!.id as string

  await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
            values (${conversationId}, ${input.userId}, ${turnId}, 'user', ${input.message})`

  await sql`update course.conversations set status = 'working', updated_at = now()
             where id = ${conversationId} and user_id = ${input.userId}`

  // Persist first, then schedule. A failed invoke leaves a durable queued turn,
  // so it is not her problem and she still gets 'queued'. It is our problem, so
  // it is logged with the turn id and never rethrown: swallowing it into an
  // empty catch would make `npm run trip`, whose invoke is the whole program,
  // print a conversation id and nothing else when the run died.
  await deps.invoke(turnId).catch((err: unknown) => {
    console.error(`invoke failed for turn ${turnId}`, err)
  })

  return { conversationId, turnId, status: 'queued' }
}
