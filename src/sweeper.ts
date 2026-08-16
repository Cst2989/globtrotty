import type postgres from 'postgres'
import { HEARTBEAT_STALE } from './repo/turns.js'

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
): Promise<{ requeued: string[]; backlog: number }> {
  const limit = opts.batchSize ?? DEFAULT_BATCH

  // Single source of truth for "stale", interpolated into both queries below so
  // the backlog count and the batch it's alarming on can never drift apart —
  // a threshold edit made in only one place would otherwise go undetected.
  const stale = sql`
    (status = 'running' and heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_STALE}))
    or (status = 'queued' and queued_at < now() - make_interval(secs => ${QUEUED_STALE}))`

  const [count] = await sql<{ count: number }[]>`
    select count(*)::int as count from turns where ${stale}`

  const rows = await sql<{ id: string }[]>`
    with batch as (
      select id from turns
       where ${stale}
       order by coalesce(heartbeat_at, queued_at)
       limit ${limit}
       for update skip locked
    )
    update turns t set status = 'queued', queued_at = now()
      from batch where t.id = batch.id
    returning t.id`

  return { requeued: rows.map((r) => r.id), backlog: count!.count }
}
