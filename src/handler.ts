import type postgres from 'postgres'
import { exceedsAnyCeiling, type Limits, type Spend } from './engine.js'
import { limitReachedMessage } from './limit-message.js'
import { readSpendFailClosed, readSpendForNewConversation } from './repo/spend.js'

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
 * Thrown only inside `firstPress`'s own transactions, when the claim it makes
 * for her key conflicts: the turn row under the ceiling, or, on the capped
 * branch that opens no turn at all, her message row. On a conversation created
 * moments earlier in that same transaction, either conflict can only mean
 * another press's key got there first (nothing else could already hold that
 * brand new conversation's one live-turn slot, and `submitMessage` is the only
 * writer of course.messages.idempotency_key in the whole course), never a busy
 * slot on some other live turn. Caught by `firstPress` itself; no caller ever
 * sees it.
 */
class KeyClaimedElsewhere extends Error {}

/**
 * Her words, kept whatever else happens. `turnId` is null on the paths where no
 * turn was opened for them: lesson 2.2's worker loads a turn's message by this
 * id, so a message with no turn is simply a message nothing is running for yet.
 *
 * `on conflict do nothing`, keyed on the same (user, idempotency key) pair as
 * `course.turns` (fix round 3: scoped to the user, not the conversation, so a
 * first press with no conversation yet can still be recognised): busy and
 * limit_reached open no turn, so the constraint on turns cannot dedupe a
 * retried press on either path, and without this one a retry would write a
 * second copy of the same sentence. Returns whether a row was actually
 * written, so a caller that also writes a reply for this press (the ceiling
 * denial below) can skip that too on a retry rather than answer the same
 * press twice.
 */
async function writeHerMessage(
  sql: postgres.Sql | postgres.TransactionSql, input: SubmitInput, conversationId: string, turnId: string | null,
): Promise<boolean> {
  const rows = await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content, idempotency_key)
    values (${conversationId}, ${input.userId}, ${turnId}, 'user', ${input.message}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`
  return rows.length > 0
}

/**
 * Persist first, then schedule. A failed invoke leaves a durable queued turn,
 * so it is not her problem and she still gets 'queued'. It is our problem, so
 * it is logged with the turn id and never rethrown: swallowing it into an
 * empty catch would make `npm run trip`, whose invoke is the whole program,
 * print a conversation id and nothing else when the run died. Called only
 * after any transaction that produced the turn has committed: invoking a
 * worker that loads this turn from the database before it is durable there
 * would race the commit.
 */
async function invokeAndLog(deps: SubmitDeps, turnId: string): Promise<void> {
  await deps.invoke(turnId).catch((err: unknown) => {
    console.error(`invoke failed for turn ${turnId}`, err)
  })
}

/** The tail every "queued" outcome shares, whichever path claimed the turn. */
async function finishQueuing(
  deps: SubmitDeps, input: SubmitInput, conversationId: string, turnId: string,
): Promise<SubmitResult> {
  const { sql } = deps
  await writeHerMessage(sql, input, conversationId, turnId)
  await sql`update course.conversations set status = 'working', updated_at = now()
             where id = ${conversationId} and user_id = ${input.userId}`
  await invokeAndLog(deps, turnId)
  return { conversationId, turnId, status: 'queued' }
}

/**
 * Everything a ceiling denial writes, in one place rather than once per path.
 * Always called inside a transaction: a capped press still gets a real reply,
 * naming which limit she hit (src/limit-message.ts), the same sentence tier 3
 * writes for the same denial (src/loop.ts, src/repo/turns.ts), and without the
 * transaction a crash between the two inserts would leave her line with no
 * reply that any retry could ever add, since a retry reads writeHerMessage's
 * on-conflict as false and skips straight past it.
 *
 * Returns whether her message row was actually written, which on this path is
 * the same fact as "this press claimed (user_id, idempotency_key) on
 * course.messages". A retry reads false and is answered once rather than
 * twice; `firstPress` reads false as "a sibling press of the same key claimed
 * it first" and throws, because no turn row exists on this path to tell it
 * that any other way.
 */
async function denyForCeiling(
  tx: postgres.TransactionSql, input: SubmitInput, conversationId: string, spend: Spend, limits: Limits,
): Promise<boolean> {
  const wroteHerMessage = await writeHerMessage(tx, input, conversationId, null)
  if (wroteHerMessage) {
    await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
              values (${conversationId}, ${input.userId}, null, 'agent', ${limitReachedMessage(spend, limits)})`
  }
  await tx`update course.conversations set status = 'limit_reached', updated_at = now()
             where id = ${conversationId} and user_id = ${input.userId}`
  return wroteHerMessage
}

/**
 * A repeated press, or a first press whose key lost the race in `firstPress`
 * below: `conversationId` already exists, so this is the path every press had
 * before fix round 3.
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
async function withConversation(deps: SubmitDeps, input: SubmitInput, conversationId: string): Promise<SubmitResult> {
  const { sql } = deps

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
    // The conversation already exists, so nothing here has to be claimed: a
    // retry of this same key is recognised by denyForCeiling's own on-conflict
    // (its false result, ignored here, is what stops her being answered
    // twice), and this path never creates a row a loser would have to undo.
    await sql.begin((tx) => denyForCeiling(tx, input, conversationId, spend, deps.limits))
    return { conversationId, turnId: null, status: 'limit_reached' }
  }

  /**
   * The insert races the unique constraint on (user_id, idempotency_key) and
   * the partial unique index on one live turn per conversation, in one
   * statement. There is no conflict target: the partial index cannot be
   * named as one, so a bare `do nothing` is the only form that tolerates
   * either rejection. Checking first and inserting second would be two
   * statements with a gap, and the gap is exactly what fifty simultaneous
   * presses find.
   */
  const inserted = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${input.userId}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`

  if (inserted.length === 0) {
    // Zero rows means one of the two constraints refused, and they mean
    // different things to her. Reading back on (user, idempotency key), the
    // pair the constraint itself is keyed on, says which: a match is the same
    // press arriving again (on whichever conversation it actually landed on,
    // which the row itself names), and no match means some other turn holds
    // this conversation's active slot.
    const dupe = await sql`
      select id, conversation_id from course.turns
       where user_id = ${input.userId} and idempotency_key = ${input.idempotencyKey}`
    if (dupe.length > 0) {
      // The press that won already wrote her message. Writing it again here is
      // how fifty presses buy one turn and fifty copies of one sentence, so this
      // path writes nothing at all.
      return { conversationId: dupe[0]!.conversation_id as string, turnId: dupe[0]!.id as string, status: 'duplicate' }
    }
    // Busy is a new message that arrived while another turn holds the slot,
    // so it is kept, with no turn of its own until module 3 picks it up.
    // A retry of the same key while still busy writes nothing a second time,
    // same as the duplicate path above, just without a turn id to answer with.
    await writeHerMessage(sql, input, conversationId, null)
    return { conversationId, turnId: null, status: 'busy' }
  }

  return finishQueuing(deps, input, conversationId, inserted[0]!.id as string)
}

/**
 * A first press: no conversation exists yet to compare the key against, and
 * the key is scoped to (user_id, idempotency_key), not to a conversation that
 * does not exist (fix round 3). Before that fix, a first press's key was
 * compared against a conversation created moments earlier for it alone, so
 * fifty concurrent first presses of one key each got their own conversation,
 * turn and message before the key was ever compared to anything.
 *
 * The ceiling is read with `readSpendForNewConversation`, her daily and
 * global totals only: a conversation that does not exist yet has spent
 * nothing, so its own ceiling can never be the one that fires here, and there
 * is nothing to fail closed on the way `withConversation`'s read does.
 *
 * Both branches create the conversation and claim her key in ONE transaction,
 * so two concurrent first presses of the SAME key cannot each buy their own
 * conversation: fifty of them must buy exactly one, same as fifty presses on
 * an existing conversation already do above. A claim conflict inside the
 * transaction means some other press's key won first; the whole attempt,
 * conversation included, is thrown away, and this press answers with the
 * winner's conversation instead. What each branch has to claim with differs,
 * which is the only reason they are not one block: under the ceiling a turn
 * row is claimed and the press replays through `withConversation` exactly like
 * a repeated press with a known id, while a capped press opens no turn (fix
 * round 4), so her message row is the claim and the denial is already complete
 * once the winner has written it.
 */
async function firstPress(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  const { sql } = deps
  const spend = await readSpendForNewConversation(sql, input.userId)

  if (exceedsAnyCeiling(spend, deps.limits)) {
    try {
      const conversationId = await sql.begin(async (tx) => {
        const [conv] = await tx`insert into course.conversations (user_id) values (${input.userId}) returning id`
        const id = conv!.id as string
        // This branch opens no turn, so course.turns cannot serialise two
        // simultaneous capped first presses of one key the way it does for the
        // queued path below. Her message row does it instead: the per-user
        // unique on course.messages means exactly one of them gets `true` back
        // here, and the rest roll the whole attempt back, the conversation they
        // just created included, rather than leaving her a pile of empty
        // conversations one press bought.
        const claimedHerKey = await denyForCeiling(tx, input, id, spend, deps.limits)
        if (!claimedHerKey) throw new KeyClaimedElsewhere()
        return id
      })
      return { conversationId, turnId: null, status: 'limit_reached' }
    } catch (err) {
      if (!(err instanceof KeyClaimedElsewhere)) throw err
      // By the time the claim above was refused, the press that won it had
      // committed: an insert that collides with a row some other transaction
      // has not committed yet waits for that transaction rather than reading
      // through it. So this read always finds the winner, and every repeat of
      // one capped press answers with the one conversation the first of them
      // created, which is what a retried capped press on a known conversation
      // already gets.
      const [winner] = await sql`
        select conversation_id from course.messages
         where user_id = ${input.userId} and idempotency_key = ${input.idempotencyKey}`
      return { conversationId: winner!.conversation_id as string, turnId: null, status: 'limit_reached' }
    }
  }

  try {
    const claimed = await sql.begin(async (tx) => {
      const [conv] = await tx`insert into course.conversations (user_id) values (${input.userId}) returning id`
      const inserted = await tx`
        insert into course.turns (conversation_id, user_id, idempotency_key)
        values (${conv!.id}, ${input.userId}, ${input.idempotencyKey})
        on conflict do nothing
        returning id`
      if (inserted.length === 0) throw new KeyClaimedElsewhere()
      return { conversationId: conv!.id as string, turnId: inserted[0]!.id as string }
    })
    return finishQueuing(deps, input, claimed.conversationId, claimed.turnId)
  } catch (err) {
    if (!(err instanceof KeyClaimedElsewhere)) throw err
    const [claimedByOther] = await sql`
      select conversation_id from course.turns
       where user_id = ${input.userId} and idempotency_key = ${input.idempotencyKey}`
    return withConversation(deps, input, claimedByOther!.conversation_id as string)
  }
}

/**
 * Tier 2: the synchronous handler. It accepts her message and returns fast,
 * doing no model work itself. A known conversation and a first press take
 * different paths (`withConversation`, `firstPress`) because only the first
 * has an existing row to compare the key against and read the ceiling from.
 */
export async function submitMessage(deps: SubmitDeps, input: SubmitInput): Promise<SubmitResult> {
  return input.conversationId === null
    ? firstPress(deps, input)
    : withConversation(deps, input, input.conversationId)
}
