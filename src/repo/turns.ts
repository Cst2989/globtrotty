import type postgres from 'postgres'
import type { FailReason, TurnState } from '../engine.js'

export type TurnInput = {
  turnId: string
  conversationId: string
  userId: string
  message: string
}

/**
 * How many times one turn may be claimed before we stop trying. A turn that
 * crashes its worker every time is a crash loop, and the fifth attempt costs
 * exactly as much as the first four and produces the same nothing. Lesson 3.5's
 * sweeper is what notices a turn stuck at this cap and ends it.
 */
export const MAX_ATTEMPTS = 5

/**
 * How often a working worker is expected to say "still here". From lesson 3.6
 * on, `src/worker.ts`'s loop ticks this on a timer while a step is in flight;
 * it is the only production caller, and it imports this constant rather than
 * keeping its own copy, so the cadence and the reasoning below stay one thing
 * in one place. HEARTBEAT_STALE below is the number this cadence is reasoned
 * against, not an independent guess.
 */
export const HEARTBEAT_INTERVAL = 25

/**
 * Seconds of silence after which a `running` turn is treated as abandoned and
 * may be taken by another worker.
 *
 * The threshold has to sit well above HEARTBEAT_INTERVAL, far enough that a few
 * lost beats or a slow round trip is not read as a death, and short enough that
 * a real death is not a fifteen-minute outage. Ninety seconds is three and a
 * half missed beats at HEARTBEAT_INTERVAL's twenty-five second cadence. What it
 * must never do is drop near the interval itself: a threshold a worker can miss
 * by being briefly busy resurrects live runs and executes the same turn twice
 * in parallel.
 *
 * A plain number of seconds rather than a SQL interval literal, so it can be
 * bound as a parameter through `make_interval()` instead of being interpolated
 * into the query text.
 */
export const HEARTBEAT_STALE = 90

/**
 * What one worker holds while it owns a turn. `attempts` is the fencing token:
 * it is not a diagnostic counter, it is the value every subsequent write carries
 * to prove it comes from the run that currently owns this row.
 */
/**
 * A `TurnState` as the parameter `sql.json` takes, which needs one cast and is
 * worth the sentence explaining it. From lesson 5.1 the transcript carries a
 * `tool_use` block whose `input` is `unknown`, because a tool's arguments are
 * the tool's shape and not this file's, and `postgres`'s own `JSONValue` union
 * has no member an `unknown` fits. Every value that actually reaches here came
 * out of a JSON response or is about to go back into one, so the round trip is
 * safe; the type system simply cannot see through that one field. Written once
 * here rather than four times inline, so there is one place to look when a
 * future block type makes the claim untrue.
 */
type JsonParam = Parameters<postgres.Sql['json']>[0]
const asJson = (state: TurnState): JsonParam => state as unknown as JsonParam

export type Claim = {
  turnId: string
  conversationId: string
  userId: string
  attempts: number
  state: TurnState | null
}

export class FencedError extends Error {
  constructor(turnId: string) {
    super(`Turn ${turnId} was claimed by another worker; this worker is superseded`)
    this.name = 'FencedError'
  }
}

type ClaimRow = {
  id: string
  conversation_id: string
  user_id: string
  attempts: number
  state: TurnState | null
}

/**
 * One statement whose WHERE names the state we are leaving. Postgres
 * re-evaluates that predicate against the row's current state at lock time, so
 * of two concurrent claims exactly one matches and the other updates zero rows
 * and gets null back.
 *
 * `select ... for update skip locked` is what people reach for here and it
 * protects less than its name suggests: it spreads a batch of claims across
 * workers, which is a throughput property, not a safety one. The safety is the
 * status re-check. A read and then a separate write in application code has a
 * gap between the two statements, and that gap is where the second worker walks
 * off owning a turn the first already owns.
 *
 * The second arm is the lease: a turn whose worker has said nothing for
 * HEARTBEAT_STALE seconds is available again, judged by
 * `coalesce(heartbeat_at, queued_at)`, the same expression the `turns_sweeper`
 * index (migration 0004) is built on and the same one the sweeper's own
 * `running` arm compares (src/sweeper.ts), so a claim and the floor walk
 * cannot disagree about which RUNNING turn is silent, and a `running` turn
 * with no heartbeat yet is reclaimable by both rather than stuck forever.
 * (Lesson 3.5's sweeper compared bare `heartbeat_at` here for two lessons,
 * which left exactly that row invisible to it; lesson 3.7's whole-branch
 * review is what caught the divergence.) The two never agree about a QUEUED
 * turn, deliberately: this arm has no time condition at all, which is what
 * makes a hand-off (releaseForContinuation) claimable at once, while the
 * sweeper waits QUEUED_STALE seconds before it treats one as orphaned.
 *
 * Returns null rather than throwing for a turn somebody else owns, because
 * "another worker has this" is the ordinary case on a platform that retries
 * invocations, and the correct response is to walk away quietly.
 */
export async function claimTurn(sql: postgres.Sql, turnId: string): Promise<Claim | null> {
  const rows = await sql<ClaimRow[]>`
    update course.turns
       set status = 'running',
           started_at = coalesce(started_at, now()),
           heartbeat_at = now(),
           attempts = attempts + 1
     where id = ${turnId}
       and attempts < ${MAX_ATTEMPTS}
       and (status = 'queued'
            or (status = 'running'
                and coalesce(heartbeat_at, queued_at)
                    < now() - make_interval(secs => ${HEARTBEAT_STALE})))
    returning id, conversation_id, user_id, attempts, state`
  const row = rows[0]
  if (!row) return null
  return {
    turnId: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    attempts: row.attempts,
    state: row.state ?? null,
  }
}

/**
 * Saves progress and refreshes the lease, guarded by the fencing token. Zero
 * rows back is not an empty update, it is proof that this worker no longer owns
 * the turn, so it throws rather than returning quietly: a superseded worker that
 * carries on doing work is the thing this whole file exists to stop.
 *
 * This guard covers only the write this function makes. The turn's completion
 * write (`completeTurn`, `failTurn`, below, from lesson 3.3) carries this same
 * token now, so a superseded worker can no longer land that write either.
 *
 * This function, `heartbeat` and `releaseForContinuation` below all end in the
 * same four-line fenced tail: match on id, attempts and status = 'running',
 * return id, throw FencedError on nothing. That repetition is deliberate, not
 * an oversight left for later cleanup: the shape of a fenced write is meant to
 * be visible whole at each of the three places lesson 3.2 uses it, rather
 * than hidden behind a shared helper the reader would have to open first.
 * Lesson 3.3 adds two more, inside a transaction, and that is the point: five
 * places now carry it, and each one still reads whole on its own.
 */
export async function saveTurnState(sql: postgres.Sql, claim: Claim, state: TurnState): Promise<void> {
  const rows = await sql`
    update course.turns set state = ${sql.json(asJson(state))}, heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

/**
 * "Still here." The cheapest fenced write there is, and the only thing standing
 * between a slow step and a turn that gets taken away mid call. A worker calls
 * it on a timer while a step is in flight, not only between steps: a step that
 * runs longer than HEARTBEAT_STALE is exactly the case a heartbeat exists for,
 * and one that only ticked between steps would go silent during the very call
 * that needed it.
 *
 * Fenced like every other write here, so it doubles as a cheap ownership
 * assertion: a caller that is about to spend money can call this first and find
 * out it has been superseded before it spends anything.
 */
export async function heartbeat(sql: postgres.Sql, claim: Claim): Promise<void> {
  const rows = await sql`
    update course.turns set heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

/**
 * Persists state AND gives the lease back, in one statement, for the
 * `continue_later` path.
 *
 * `saveTurnState` alone is the trap. It leaves the row `running` with a fresh
 * `heartbeat_at`, so the re-invocation's own `claimTurn` satisfies neither arm:
 * not the queued one, because the status is `running`, and not the stale one,
 * because the heartbeat was just refreshed. The continuation would then wait for
 * the sweeper, which is HEARTBEAT_STALE seconds of staleness plus up to a sweep
 * interval of cron, for a hand-off that was entirely deliberate.
 *
 * Setting the status back to `queued` makes it claimable immediately.
 * `heartbeat_at` is stamped fresh too, not left at the dying worker's last
 * beat: `turns_sweeper` (migration 0004) reads `coalesce(heartbeat_at,
 * queued_at)`, and a stale beat left on a `queued` row would make a
 * continuation handed back a moment ago indistinguishable, to that index,
 * from a turn abandoned minutes ago.
 *
 * A hand-back spends an attempt, because the next claim increments the
 * token, and it must, or two workers could end up sharing one token value.
 * That makes MAX_ATTEMPTS a ceiling on continuations as well as on crashes,
 * today; lesson 3.5 is where a turn parked at the cap gets an ending, and a
 * separate continuation count, distinct from the crash-loop count, is the
 * change to make if long turns start hitting it.
 *
 * `spendMicros` is what THIS attempt spent, added the same way both closers
 * add theirs. Without it the money an attempt spent before handing back would
 * be lost to the turn's own row: a closer only ever runs on the LAST attempt,
 * so a turn that continued twice at 500 micros an attempt would end reading
 * 500 against a conversation that was charged 1500. Conversation and daily
 * spend are not touched here for the same reason the closers do not touch
 * them: `recordSpend` (lesson 2.6) owns those two, and the worker has already
 * called it, or the agent has, before this write.
 */
export async function releaseForContinuation(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
  spendMicros: bigint,
): Promise<void> {
  const rows = await sql`
    update course.turns
       set state = ${sql.json(asJson(state))}, status = 'queued', queued_at = now(), heartbeat_at = now(),
           spend_usd_micros = spend_usd_micros + ${spendMicros.toString()}
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
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
 *
 * The status filter accepts a claimed turn as well as a queued one, because
 * from lesson 3.1 the worker claims before it loads and a claim sets 'running'.
 * A turn that has already finished is still excluded, so a stray invocation of
 * a `done` turn reads nothing; `claimTurn` refuses that turn first anyway, and
 * this filter is the second of the two answers rather than the only one.
 *
 * From lesson 3.6 on, `runTurn` (src/worker.ts) is the production caller: it
 * seeds a fresh claim's transcript from exactly the message THIS turn was
 * opened for, never from the newest row on the conversation, which can be a
 * later press's message stamped `turn_id = null` while this turn was still
 * queued (src/handler.ts's `busy` path). That is the failure this join was
 * built to prevent, spelled out above, and the fix a review caught: an
 * earlier draft of the worker loop read the whole conversation instead and
 * reintroduced it.
 */
export async function loadTurnInput(sql: postgres.Sql, turnId: string): Promise<TurnInput | null> {
  const rows = await sql`
    select t.id, t.conversation_id, t.user_id, m.content
      from course.turns t
      join course.messages m on m.turn_id = t.id and m.role = 'user'
     where t.id = ${turnId} and t.status in ('queued', 'running')`
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
 * Ends a turn in one transaction: its state, its status, its spend, her reply
 * and the conversation's status all land together or not at all. A crash between
 * any two of these used to leave a `done` turn with no reply and a conversation
 * that reads as still working, and the sweeper cannot rescue that: it only ever
 * looks at live turns.
 *
 * Parking is TERMINAL for the turn. A parked turn is `done`, not `running`.
 * Left `running`, lesson 3.5's sweeper would reclaim and re-execute a
 * conversation that is simply waiting on her, every heartbeat window, quietly
 * re-billing a state that is supposed to cost nothing.
 *
 * `spendMicros` is the spend to add for this attempt, not a running total:
 * both statements below write it as `spend_usd_micros + ...`. The `+` is load
 * bearing rather than defensive. A closer is terminal, so at most one of them
 * ever lands for one turn, but `releaseForContinuation` above adds every
 * continued attempt's spend through the same column, so what a closer finds
 * there is already the sum of the attempts that came before it and an
 * overwrite would throw them away. It lands on `turns.spend_usd_micros` only.
 * Conversation and daily spend accrue through `recordSpend` (lesson 2.6) and
 * adding them here as well would double-count the conversation and bypass the
 * daily counter a ceiling reads.
 */
export async function completeTurn(
  sql: postgres.Sql,
  claim: Claim,
  opts: {
    state: TurnState
    /** Null writes no row: an empty bubble in her thread reads worse than nothing. */
    agentMessage: string | null
    parked: boolean
    spendMicros: bigint
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update course.turns
         set status = 'done', state = ${tx.json(asJson(opts.state))},
             finished_at = now(), heartbeat_at = now(),
             spend_usd_micros = spend_usd_micros + ${opts.spendMicros.toString()}
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)

    if (opts.agentMessage !== null) {
      await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${opts.agentMessage})`
    }

    // A zero-row update is a success to Postgres, not an error, so without this
    // check a conversation row that does not match would let the transaction
    // commit with the turn 'done' and the conversation silently still
    // 'working' forever: the exact half-done state this function's opening
    // sentence promises cannot happen. `recordSpend` (src/repo/spend.ts) checks
    // this same statement for the same reason.
    const conv = await tx`update course.conversations
                             set status = ${opts.parked ? 'awaiting_user' : 'active'}, updated_at = now()
                           where id = ${claim.conversationId} and user_id = ${claim.userId}
                          returning id`
    if (conv.length === 0) throw new Error('completeTurn: conversation not found (fail closed)')
  })
  // Anything that tells her the work is ready belongs AFTER this commit and may
  // never fail the turn: her work is already saved and already billed, and a
  // failed notification that took the turn's status down with it would tell her
  // that finished work does not exist.
}

/**
 * What a closer looks like, so `completeIfLinkEmitted` (src/worker.ts) can be
 * handed one rather than owning the only one. Two exist, and only two:
 * `completeTurn` above, and `completeReapedTurn` below.
 */
export type TurnCloser = (
  sql: postgres.Sql,
  claim: Claim,
  opts: { state: TurnState; agentMessage: string | null; parked: boolean; spendMicros: bigint },
) => Promise<void>

/**
 * `completeTurn` for a caller that holds no claim: the sweeper (src/sweeper.ts).
 *
 * From lesson 4.6's fix round the crash-loop arm no longer marks a turn that
 * emitted a booking link `failed`. It ends it `done` with the hand-off sentence
 * rebuilt from `course.link_clicks`, through the same `completeIfLinkEmitted`
 * every exit in the worker goes through, which is what makes rule 6
 * (src/cashier.ts) one rule with one implementation rather than a worker rule
 * the floor walk contradicts.
 *
 * ONE clause differs from `completeTurn`, and it is worth being exact about
 * which, because the rest of the fence is intact. A worker's claim is proof it
 * is the live holder of a `running` row, so `completeTurn` matches on
 * `status = 'running'`. The sweeper holds no claim and by definition arrives at
 * a turn no worker is holding, which is `running` with a dead heartbeat OR
 * `queued` after a requeue it has already made, and that second case is the
 * common one: a turn reaches MAX_ATTEMPTS by being requeued, and `claimTurn`
 * then refuses it, so it sits `queued` for ever. Matching `'running'` alone
 * would leave exactly the turns this exists for untouched.
 *
 * `attempts = claim.attempts` is kept and is doing real work: a sweeper that
 * read the row a moment before another sweeper requeued it finds the token
 * moved and writes nothing, so two floor walks cannot both close one turn. The
 * caller learns that from the throw, like every other fenced writer here.
 *
 * `spendMicros` is 0 from the sweeper and the `+` is still written, for the
 * reason `completeTurn`'s docstring gives: whatever is in the column is the sum
 * of the attempts that came before and must not be overwritten.
 */
export async function completeReapedTurn(
  sql: postgres.Sql,
  claim: Claim,
  opts: {
    state: TurnState
    agentMessage: string | null
    parked: boolean
    spendMicros: bigint
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update course.turns
         set status = 'done', state = ${tx.json(asJson(opts.state))},
             finished_at = now(), heartbeat_at = now(),
             spend_usd_micros = spend_usd_micros + ${opts.spendMicros.toString()}
       where id = ${claim.turnId} and attempts = ${claim.attempts}
         and status in ('running', 'queued')
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)

    if (opts.agentMessage !== null) {
      await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${opts.agentMessage})`
    }

    const conv = await tx`update course.conversations
                             set status = ${opts.parked ? 'awaiting_user' : 'active'}, updated_at = now()
                           where id = ${claim.conversationId} and user_id = ${claim.userId}
                          returning id`
    if (conv.length === 0) throw new Error('completeReapedTurn: conversation not found (fail closed)')
  })
}

/**
 * The other way a turn ends. Same transaction, same fencing token, and the
 * conversation status mirrors the reason rather than collapsing to 'failed':
 * `submitMessage` (src/handler.ts) sets 'limit_reached' for the identical
 * condition hit before the turn was queued, so hitting it one step in has to
 * read the same way to her.
 *
 * `agentMessage` is optional because not every failure has earned a sentence
 * yet. A ceiling has one (src/limit-message.ts) and passes it here; `step_cap`
 * and `deadline_exceeded` do not, and pass nothing rather than an empty string
 * that would become a blank row.
 *
 * `failed` is terminal: neither arm of `claimTurn` admits it and the
 * sweeper's index (migration 0004) does not cover it either, so a recorded
 * failure is not retried. `MAX_ATTEMPTS` is spent by workers that die without
 * reaching either closer, and, from lesson 3.5, by the sweeper's own requeue,
 * which advances the count with no worker involved at all so that a turn nothing
 * ever invokes still reaches an ending; an explicitly recorded failure is a
 * decision, not an accident, and costs exactly one attempt.
 *
 * `heartbeat_at` is refreshed here too, for the same reason `completeTurn`
 * refreshes it: neither matters, because both `done` and `failed` leave the
 * sweeper's predicate, but a terminal row's heartbeat should read as "nothing
 * is watching this any more" rather than sit at whatever it was mid-run.
 */
export async function failTurn(
  sql: postgres.Sql,
  claim: Claim,
  reason: FailReason,
  spendMicros: bigint,
  agentMessage: string | null = null,
): Promise<void> {
  const conversationStatus = reason === 'limit_reached' ? 'limit_reached' : 'failed'
  await sql.begin(async (tx) => {
    const rows = await tx`
      update course.turns
         set status = 'failed', fail_reason = ${reason}, finished_at = now(), heartbeat_at = now(),
             spend_usd_micros = spend_usd_micros + ${spendMicros.toString()}
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)

    if (agentMessage !== null) {
      await tx`insert into course.messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${agentMessage})`
    }

    // Same reasoning as completeTurn's matching check just above: a zero-row
    // update here is a silent success to Postgres, and this transaction's
    // whole promise is that either everything lands or nothing does.
    const conv = await tx`update course.conversations set status = ${conversationStatus}, updated_at = now()
                          where id = ${claim.conversationId} and user_id = ${claim.userId}
                          returning id`
    if (conv.length === 0) throw new Error('failTurn: conversation not found (fail closed)')
  })
}
