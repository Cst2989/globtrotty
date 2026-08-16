import type postgres from 'postgres'
import type { TurnState } from '../engine.js'

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
