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
 * Seconds of silence after which a `running` turn is treated as abandoned and
 * may be taken by another worker.
 *
 * The threshold has to sit above the hard execution ceiling of the environment
 * that runs a turn. Tier 3 is a Netlify background function, killed at fifteen
 * minutes, and lesson 2.3's deadline check makes a healthy turn hand off before
 * that, so ninety seconds of total silence from a process that is supposed to
 * report in every twenty-five is a dead process, not a busy one. Set below the
 * ceiling instead, and the sweeper resurrects runs that are still alive and the
 * same turn executes twice in parallel.
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
 * Returns null rather than throwing for a turn somebody else owns, because
 * "another worker has this" is the ordinary case on a platform that retries
 * invocations, and the correct response is to walk away quietly.
 *
 * The second arm is the lease: a turn whose worker has said nothing for
 * HEARTBEAT_STALE seconds is available again. The queued arm has no time
 * condition, which is what makes a deliberate hand-off (releaseForContinuation)
 * claimable at once rather than after a staleness window.
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
                and heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_STALE})))
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
 * write still goes through `finishTurn`, which carries no token at all until
 * lesson 3.3 replaces it, so a superseded worker can still land that write.
 */
export async function saveTurnState(sql: postgres.Sql, claim: Claim, state: TurnState): Promise<void> {
  const rows = await sql`
    update course.turns set state = ${sql.json(state)}, heartbeat_at = now()
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
 */
export async function releaseForContinuation(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
): Promise<void> {
  const rows = await sql`
    update course.turns
       set state = ${sql.json(state)}, status = 'queued', queued_at = now()
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
