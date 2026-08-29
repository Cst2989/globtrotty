import type postgres from 'postgres'
import { exceedsAnyCeiling, type Limits } from './engine.js'
import { limitReachedMessage } from './limit-message.js'
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
  idempotencyKey: string
}

export type SubmitResult = {
  conversationId: string
  // Null, not an empty string, when no turn exists to name: an empty string is
  // indistinguishable from a truncated id at a glance and invites a check that
  // silently does the wrong thing.
  turnId: string | null
  status: 'queued' | 'duplicate' | 'limit_reached' | 'busy'
}

/**
 * Her words, kept whatever else happens. `turnId` is null on the paths where no
 * turn was opened for them: lesson 2.2's worker loads a turn's message by this
 * id, so a message with no turn is simply a message nothing is running for yet.
 *
 * `on conflict do nothing`, keyed on the same (conversation, idempotency key)
 * pair as `course.turns`: busy and limit_reached open no turn, so the
 * constraint on turns cannot dedupe a retried press on either path, and
 * without this one a retry would write a second copy of the same sentence.
 * Returns whether a row was actually written, so a caller that also writes a
 * reply for this press (the ceiling denial below) can skip that too on a
 * retry rather than answer the same press twice.
 */
async function writeHerMessage(
  sql: postgres.Sql, input: SubmitInput, conversationId: string, turnId: string | null,
): Promise<boolean> {
  const rows = await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content, idempotency_key)
    values (${conversationId}, ${input.userId}, ${turnId}, 'user', ${input.message}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`
  return rows.length > 0
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
  // Unlike the ceiling denial below, this path does NOT keep her message: a
  // thrown read means there is no confirmed row to attach it to. The same
  // query also doubles as the tenancy check, since it filters on
  // (id, user_id) together: a conversationId that exists but belongs to
  // someone else looks exactly like one that does not exist, and is rejected
  // here, before anything is written, the same way an unreachable database
  // would be.
  const spend = await readSpendFailClosed(sql, input.userId, conversationId)

  // All three ceilings, through the same predicate decideNext uses rather than a
  // second copy of the same three comparisons. The global one is checked here
  // rather than left to the worker because a capped account must be refused
  // before a turn is queued at all; otherwise the refusal arrives one step into
  // the turn, after a model call has already been paid for. It can fire while
  // both of this user's own counters read zero: it protects the account, not the
  // user.
  //
  // This check is advisory, not authoritative: it is a read then a decision
  // with nothing serialising it against a concurrent submit on the same
  // account, so two requests can both read "under the ceiling" and both
  // queue. It exists to avoid starting doomed work early, not to bound spend
  // precisely; the read inside the loop, once per step, is the one that
  // actually enforces the ceiling, because nothing can be spent between its
  // read and its decision without another step (and another read) in between.
  if (exceedsAnyCeiling(spend, deps.limits)) {
    const wroteHerMessage = await writeHerMessage(sql, input, conversationId, null)
    // A capped press still gets a real reply, naming which limit she hit
    // (src/limit-message.ts), the same sentence tier 3 writes for the same
    // denial (src/loop.ts, src/repo/turns.ts). Skipped on a retry of a press
    // already answered: writeHerMessage returning false means this key has
    // already written both her line and this one.
    if (wroteHerMessage) {
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${conversationId}, ${input.userId}, null, 'agent', ${limitReachedMessage(spend, deps.limits)})`
    }
    await sql`update course.conversations set status = 'limit_reached', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return { conversationId, turnId: null, status: 'limit_reached' }
  }

  /**
   * The insert races the unique constraint on (conversation_id,
   * idempotency_key) and the partial unique index on one live turn per
   * conversation, in one statement. There is no conflict target: the partial
   * index cannot be named as one, so a bare `do nothing` is the only form that
   * tolerates either rejection. Checking first and inserting second would be two
   * statements with a gap, and the gap is exactly what fifty simultaneous
   * presses find.
   */
  const inserted = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${input.userId}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`

  if (inserted.length === 0) {
    // Zero rows means one of the two constraints refused, and they mean different
    // things to her. Reading back on the idempotency key says which: a match is
    // the same press arriving again, and no match means some other turn holds the
    // active slot.
    const dupe = await sql`
      select id from course.turns
       where conversation_id = ${conversationId} and idempotency_key = ${input.idempotencyKey}`
    if (dupe.length > 0) {
      // The press that won already wrote her message. Writing it again here is
      // how fifty presses buy one turn and fifty copies of one sentence, so this
      // path writes nothing at all.
      return { conversationId, turnId: dupe[0]!.id as string, status: 'duplicate' }
    }
    // Busy is a new message that arrived while another turn holds the slot,
    // so it is kept, with no turn of its own until module 3 picks it up.
    // A retry of the same key while still busy writes nothing a second time,
    // same as the duplicate path above, just without a turn id to answer with.
    await writeHerMessage(sql, input, conversationId, null)
    return { conversationId, turnId: null, status: 'busy' }
  }

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
