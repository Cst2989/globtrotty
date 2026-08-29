import type postgres from 'postgres'
import { exceedsAnyCeiling, type Limits } from './engine.js'
import { readSpendFailClosed } from './repo/spend.js'

export type SubmitDeps = {
  sql: postgres.Sql
  /** Starts the work. Injected, so tests never make an HTTP call. */
  invoke: (turnId: string) => Promise<void>
  limits: Limits
}

export type SubmitInput = {
  userId: string
  conversationId: string | null
  message: string
}

export type SubmitResult = {
  conversationId: string
  // Null, not an empty string, when no turn exists to name: an empty string is
  // indistinguishable from a truncated id at a glance and invites a check that
  // silently does the wrong thing.
  turnId: string | null
  status: 'queued' | 'limit_reached'
}

/**
 * Her words, kept whatever else happens. `turnId` is null on the paths where no
 * turn was opened for them: lesson 2.2's worker loads a turn's message by this
 * id, so a message with no turn is simply a message nothing is running for yet.
 */
async function writeHerMessage(
  sql: postgres.Sql, input: SubmitInput, conversationId: string, turnId: string | null,
): Promise<void> {
  await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
            values (${conversationId}, ${input.userId}, ${turnId}, 'user', ${input.message})`
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

  // Fail closed: this throws rather than returning zero when it cannot confirm.
  // Deliberately before the turn is written, so a database hiccup denies the
  // request outright rather than queueing work on top of an unconfirmed state.
  const spend = await readSpendFailClosed(sql, input.userId, conversationId)

  // All three ceilings, through the same predicate decideNext uses rather than a
  // second copy of the same three comparisons. The global one is checked here
  // rather than left to the worker because a capped account must be refused
  // before a turn is queued at all; otherwise the refusal arrives one step into
  // the turn, after a model call has already been paid for. It can fire while
  // both of this user's own counters read zero: it protects the account, not the
  // user.
  if (exceedsAnyCeiling(spend, deps.limits)) {
    await writeHerMessage(sql, input, conversationId, null)
    await sql`update course.conversations set status = 'limit_reached', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return { conversationId, turnId: null, status: 'limit_reached' }
  }

  const inserted = await sql`
    insert into course.turns (conversation_id, user_id) values (${conversationId}, ${input.userId})
    returning id`
  const turnId = inserted[0]!.id as string

  await writeHerMessage(sql, input, conversationId, turnId)

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
