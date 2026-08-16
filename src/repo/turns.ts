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

export async function saveTurnState(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
): Promise<void> {
  const rows = await sql`
    update turns set state = ${sql.json(state)}, heartbeat_at = now()
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
 */
export async function releaseForContinuation(
  sql: postgres.Sql,
  claim: Claim,
  state: TurnState,
): Promise<void> {
  const rows = await sql`
    update turns
       set state = ${sql.json(state)}, status = 'queued', queued_at = now()
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

    await tx`
      update conversations
         set status = ${opts.parked ? 'awaiting_user' : 'active'},
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
    await tx`update conversations set status = ${conversationStatus}, updated_at = now()
              where id = ${claim.conversationId} and user_id = ${claim.userId}`
  })
}
