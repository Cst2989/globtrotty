import type postgres from 'postgres'
import { HEARTBEAT_STALE, MAX_ATTEMPTS } from './repo/turns.js'

/**
 * Seconds a `queued` turn may sit unenqueued before the sweeper treats it as
 * orphaned (e.g. the enqueue HTTP call failed after the row was inserted).
 * Deliberately a distinct constant from `HEARTBEAT_STALE` — the two describe
 * different failure modes — but both are plain seconds bound via
 * `make_interval()`, never interpolated into the query text.
 */
export const QUEUED_STALE = 120

export const DEFAULT_BATCH = 100

/**
 * Bounded so the whole sweep fits inside a 30s scheduled function. Rows are only
 * flipped once they have been selected under `FOR UPDATE SKIP LOCKED`, so a batch
 * can safely be spread across concurrent sweeper workers, and both `queued` and
 * `running` turns remain visible to the next sweep, so a killed sweeper never
 * strands the work it was rescuing.
 *
 * Only `('queued','running')` turns are ever candidates, so a parked turn
 * (`turns.status = 'done'` with the conversation `awaiting_user`) is out of
 * scope by construction — the sweeper cannot resurrect it and re-bill a model
 * call for a conversation that is simply waiting on the user.
 */
export async function sweep(
  sql: postgres.Sql,
  opts: { batchSize?: number } = {},
): Promise<{ requeued: string[]; backlog: number; reaped: string[] }> {
  const limit = opts.batchSize ?? DEFAULT_BATCH

  // Single source of truth for "stale", interpolated into every query below so
  // the reap, backlog count, and the batch it's alarming on can never drift apart —
  // a threshold edit made in only one place would otherwise go undetected.
  const stale = sql`
    (status = 'running' and heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_STALE}))
    or (status = 'queued' and queued_at < now() - make_interval(secs => ${QUEUED_STALE}))`

  /**
   * A turn at attempts >= MAX_ATTEMPTS can never be claimed again — claimTurn's own
   * `attempts < MAX_ATTEMPTS` guard sees to that — so without this step it would
   * bounce forever between stale 'running' and requeued 'queued' below: alive
   * looking, never actually worked, its conversation stuck 'working' forever, and
   * `turns_one_active_per_conversation` locked against a fresh attempt in that
   * thread. Reap it here, BEFORE the requeue batch below is chosen: fail the turn
   * with 'crash_loop' and move its conversation off 'working' so the user isn't
   * staring at a spinner that will never resolve. All three writes (turn, its
   * conversation) happen in one statement via chained CTEs.
   */
  const reaped = await sql<{ id: string }[]>`
    with dead as (
      select id from turns
       where attempts >= ${MAX_ATTEMPTS} and (${stale})
       for update skip locked
    ),
    reap as (
      update turns t set status = 'failed', fail_reason = 'crash_loop', finished_at = now()
        from dead where t.id = dead.id
      returning t.id, t.conversation_id, t.user_id
    ),
    convo as (
      update conversations c set status = 'failed', updated_at = now()
        from reap r where c.id = r.conversation_id and c.user_id = r.user_id
    )
    select id from reap`

  // attempts < MAX_ATTEMPTS excludes rows the reap above just failed (they no
  // longer match `stale` anyway, since their status is now 'failed', but the
  // explicit filter keeps this query's intent readable on its own).
  const [count] = await sql<{ count: number }[]>`
    select count(*)::int as count from turns where (${stale}) and attempts < ${MAX_ATTEMPTS}`

  const rows = await sql<{ id: string }[]>`
    with batch as (
      select id from turns
       where (${stale}) and attempts < ${MAX_ATTEMPTS}
       order by coalesce(heartbeat_at, queued_at)
       limit ${limit}
       for update skip locked
    )
    update turns t set status = 'queued', queued_at = now()
      from batch where t.id = batch.id
    returning t.id`

  return { requeued: rows.map((r) => r.id), backlog: count!.count, reaped: reaped.map((r) => r.id) }
}
