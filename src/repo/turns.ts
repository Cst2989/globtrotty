import type postgres from 'postgres'
import type { TurnState, FailReason } from '../engine.js'

/**
 * Seconds of heartbeat silence after which a `running` turn is considered dead
 * and eligible for reclaim by another worker. Expressed as a plain number (not a
 * SQL interval literal) so it can be passed as a bound parameter to
 * `make_interval()` rather than interpolated into the query text.
 */
export const HEARTBEAT_STALE = 90
export const MAX_ATTEMPTS = 5

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
 * One statement whose WHERE names the state we are leaving. Postgres re-evaluates
 * the predicate against the row's current state at lock time, so of two concurrent
 * claims exactly one matches. `attempts` doubles as the fencing token: every
 * subsequent write must carry the `attempts` value returned here, or it is rejected.
 */
export async function claimTurn(sql: postgres.Sql, turnId: string): Promise<Claim | null> {
  const rows = await sql<ClaimRow[]>`
    update turns
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
  const r = rows[0]
  if (!r) return null
  return {
    turnId: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    attempts: r.attempts,
    state: r.state ?? null,
  }
}

/**
 * `state as never` at every `.json(...)` call site in this file, including
 * `completeTurn`'s, which already carried it.
 *
 * `turns.state` is `jsonb` and stores every shape a `TurnState` can take. What
 * rejects it is postgres.js's `JSONValue`, a structural type with no room for
 * `unknown` — and `ToolUseBlock.input` (src/engine.ts) is deliberately
 * `unknown`, because a tool call's arguments are the model's to shape, not ours
 * to enumerate.
 *
 * WHAT THE CAST REQUIRES OF CALLERS, stated because it is a real obligation and
 * not a formality: `ToolUseBlock.input` must hold only JSON-derived values.
 * `sql.json` throws on a `bigint`, a `Date`, a `Map` or a cycle — and at
 * `saveTurnState` it throws AFTER `finishToolCall` and `recordSpend` have
 * already committed, so the tool call is recorded and paid for while the
 * transcript that mentions it is not. Today's only writer is a provider
 * response parsed from JSON, which cannot contain any of those; anything that
 * constructs `input` by hand must keep it that way.
 */
export async function saveTurnState(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
): Promise<void> {
  const rows = await sql`
    update turns set state = ${sql.json(state as never)}, heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

export async function heartbeat(sql: postgres.Sql, claim: Claim): Promise<void> {
  const rows = await sql`
    update turns set heartbeat_at = now()
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

/**
 * The `continue_later` path must persist state AND release ownership in the same
 * act. `saveTurnState` alone leaves `status = 'running'` with a fresh
 * `heartbeat_at` — so the re-invocation's own `claimTurn` (which requires
 * `status = 'queued'`, or a `running` row whose heartbeat has gone stale for
 * HEARTBEAT_STALE seconds) can satisfy neither condition and returns null. The
 * continuation would then only ever recover via the sweeper: up to
 * HEARTBEAT_STALE seconds of staleness plus up to a sweep interval of cron.
 *
 * Setting `status = 'queued'` here makes the turn immediately claimable — the
 * queued arm of `claimTurn`'s WHERE has no staleness requirement at all.
 *
 * `spendMicros` is the run's accumulated total so far (the caller's running
 * total, same accounting convention as `completeTurn`/`failTurn`), added to
 * `turns.spend_usd_micros` here for the same reason it is added on every other
 * exit path: `turns.spend_usd_micros` is a report column of what this TURN
 * has cost, and a turn that stops for a deadline rather than finishing or
 * failing must not report 0 for however much it already spent. The caller
 * (`runTurn`, src/worker.ts) must reset its own running total to `0n`
 * immediately after this call: the re-invocation this triggers is a FRESH
 * `runTurn` call that claims the turn and starts its own `turnSpend` at `0n`,
 * so the amount recorded here must never be added again by the same process
 * that just recorded it.
 */
export async function releaseForContinuation(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
  spendMicros: bigint,
): Promise<void> {
  const rows = await sql`
    update turns
       set state = ${sql.json(state as never)}, status = 'queued', queued_at = now(),
           spend_usd_micros = spend_usd_micros + ${spendMicros.toString()}
     where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
    returning id`
  if (rows.length === 0) throw new FencedError(claim.turnId)
}

/**
 * Ends a turn in a single transaction: state, status, spend, message, and the
 * conversation's status all land together or not at all. Crashing between any
 * two of these writes used to leave a `done` turn with no message and an
 * `active` conversation forever — the sweeper only rescues live turns.
 *
 * Parking is TERMINAL for the turn: a parked turn is `done`, not `running`.
 * Left `running`, the sweeper would reclaim and re-execute a parked
 * conversation every heartbeat window, quietly re-billing a feature that's
 * supposed to cost nothing while it waits on the user.
 *
 * Spend here is turn-level only: `turns.spend_usd_micros` is set to the
 * amount for this turn. Conversation and daily spend accrue exclusively
 * through `recordSpend` (Task 8) — duplicating that here would double-count
 * conversation spend and silently bypass the daily_usage counter that a
 * spend limit reads.
 */
export async function completeTurn(
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
      update turns
         set status = 'done', state = ${tx.json(opts.state as never)},
             finished_at = now(), heartbeat_at = now(),
             spend_usd_micros = spend_usd_micros + ${opts.spendMicros.toString()}
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)

    if (opts.agentMessage !== null) {
      await tx`insert into messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${opts.agentMessage})`
    }

    // `case when status = 'escalated' then 'escalated' else ...`: an escalation
    // (src/repo/escalations.ts) is always followed, in the same turn, by the
    // driver's closing message — which reaches this exact write with `parked:
    // true`. Without the guard that message's completeTurn would stamp
    // 'awaiting_user' right back over the terminal status the escalation just
    // set, and a human paged to look at the conversation would find it marked
    // as if nothing had happened.
    await tx`
      update conversations
         set status = case when status = 'escalated' then 'escalated'
                           else ${opts.parked ? 'awaiting_user' : 'active'} end,
             updated_at = now()
       where id = ${claim.conversationId} and user_id = ${claim.userId}`
  })
  // Notification goes here, AFTER commit, and may never fail the turn:
  //   notifyUser(claim.conversationId).catch(logOnly)
}

/**
 * `spendMicros` is the total accumulated across every step of THIS turn (the
 * caller's running total, not a delta) — same accounting convention as
 * `completeTurn`, so `turns.spend_usd_micros` reflects what a turn spent even
 * when it stops at a ceiling rather than finishing normally.
 *
 * The conversation status mirrors the reason rather than collapsing everything
 * to 'failed': `submitMessage` (src/handler.ts) sets 'limit_reached' for the
 * exact same condition hit pre-turn, so hitting the cap one step into a turn
 * must read the same way to the user — a spend ceiling is not "something
 * broke".
 */
export async function failTurn(
  sql: postgres.Sql,
  claim: Claim,
  reason: FailReason,
  spendMicros: bigint,
  /**
   * Optional agent message, written INSIDE the same fenced transaction as the
   * status update rather than by the caller beforehand. A refusal must leave her
   * with words she can act on (spec section 8), and a message written outside
   * this transaction could land on a turn we no longer own — the exact write the
   * fencing token exists to reject. Defaults to null, so a crash-path failure
   * still says nothing rather than inventing an explanation.
   */
  agentMessage: string | null = null,
): Promise<void> {
  const conversationStatus = reason === 'limit_reached' ? 'limit_reached' : 'failed'
  await sql.begin(async (tx) => {
    const rows = await tx`
      update turns
         set status = 'failed', fail_reason = ${reason}, finished_at = now(),
             spend_usd_micros = spend_usd_micros + ${spendMicros.toString()}
       where id = ${claim.turnId} and attempts = ${claim.attempts} and status = 'running'
      returning id`
    if (rows.length === 0) throw new FencedError(claim.turnId)
    if (agentMessage !== null) {
      await tx`insert into messages (conversation_id, user_id, turn_id, role, content)
               values (${claim.conversationId}, ${claim.userId}, ${claim.turnId},
                       'agent', ${agentMessage})`
    }
    // Same sticky guard as completeTurn's, and for the same reason: a `fail`
    // step can follow an escalation in the same turn, and must not overwrite
    // the terminal 'escalated' status with 'failed' or 'limit_reached'.
    await tx`update conversations
                set status = case when status = 'escalated' then 'escalated' else ${conversationStatus} end,
                    updated_at = now()
              where id = ${claim.conversationId} and user_id = ${claim.userId}`
  })
}
