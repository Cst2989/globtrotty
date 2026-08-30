import type postgres from 'postgres'
import { TURN_FAILED_MESSAGE } from './failure-message.js'
import { HEARTBEAT_STALE, MAX_ATTEMPTS } from './repo/turns.js'

/**
 * Seconds a `queued` turn may sit before the sweeper treats it as orphaned: the
 * invocation that should have started it never arrived, or died before it
 * claimed anything.
 *
 * A separate constant from HEARTBEAT_STALE on purpose, because the two describe
 * different failures. A silent `running` turn had a worker that stopped talking;
 * a stale `queued` turn never had one at all, and nothing about the fifteen
 * minute execution ceiling bounds how long it should wait.
 */
export const QUEUED_STALE = 120

/** One sweep must fit inside a scheduled function's own budget. */
export const DEFAULT_BATCH = 100

export type SweepResult = {
  /** Turns handed back to the queue, for the caller to re-invoke. */
  requeued: string[]
  /** Turns failed as crash loops: out of attempts, and she has been told. */
  reaped: string[]
  /** Turns failed as stalled: nothing could ever have run them. */
  stalled: string[]
  /** Every stale turn under the attempt cap, including the ones this batch took. */
  backlog: number
}

/**
 * The floor walk. A sweeper, in the older sense of the job, is the person who
 * walks the floor after the shift and picks up whatever got left behind.
 *
 * Rows are only touched once selected under `for update skip locked`, so two
 * sweepers running at once split the work rather than fight over it, and a
 * sweeper that is killed mid batch leaves every row it had not finished with
 * still visible to the next sweep.
 *
 * Only `queued` and `running` turns are ever candidates, so a parked turn
 * (`done`, with the conversation `awaiting_user`) is out of scope by
 * construction: the sweeper cannot resurrect a conversation that is waiting on
 * her and re-bill it every heartbeat window.
 */
export async function sweep(
  sql: postgres.Sql,
  opts: { batchSize?: number } = {},
): Promise<SweepResult> {
  const limit = opts.batchSize ?? DEFAULT_BATCH

  // One definition of "stale", composed into every query below, so the reap, the
  // backlog count and the batch cannot drift apart. A threshold edited in one of
  // three copies is a sweeper that alarms on one set of rows and acts on another.
  const stale = sql`
    (status = 'running' and heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_STALE}))
    or (status = 'queued' and queued_at < now() - make_interval(secs => ${QUEUED_STALE}))`

  /**
   * First, the turn nothing can ever run: `queued`, old enough, and with no user
   * message to run. Module 2's hand-off. Requeueing it would be a floor walk with
   * no end, so it is failed as `stalled` and its conversation is handed back, and
   * the point of the whole thing is that last part: the partial unique index on
   * one live turn per conversation was holding her thread shut.
   *
   * No message is written for her. The press that claimed her key already wrote
   * her sentence on this same conversation and is already being answered; a
   * second reply here would answer a question nobody asked. Done FIRST, so a
   * messageless turn is diagnosed as stalled rather than as whatever the crash
   * loop query below would have called it.
   *
   * A messageless turn may arrive here as `running` rather than `queued`,
   * because tier 3 claims before it loads (lesson 3.1) and then finds nothing to
   * run. The batch below requeues it, and the next sweep diagnoses it as
   * `stalled`: two ticks rather than one, and no third state to handle.
   */
  const stalled = await sql<{ id: string }[]>`
    with dead as (
      select t.id from course.turns t
       where t.status = 'queued'
         and t.queued_at < now() - make_interval(secs => ${QUEUED_STALE})
         and not exists (
           select 1 from course.messages m where m.turn_id = t.id and m.role = 'user')
       for update skip locked
    ),
    reap as (
      update course.turns t set status = 'failed', fail_reason = 'stalled', finished_at = now()
        from dead where t.id = dead.id
      returning t.id, t.conversation_id, t.user_id
    ),
    convo as (
      update course.conversations c set status = 'active', updated_at = now()
        from reap r
       where c.id = r.conversation_id and c.user_id = r.user_id and c.status = 'working'
    )
    select id from reap`

  /**
   * Then the crash loop. A turn at MAX_ATTEMPTS can never be claimed again,
   * because claimTurn's own guard refuses it, so without this it bounces between
   * stale `running` and requeued `queued` forever: alive-looking, never worked,
   * its conversation stuck on `working` and its live-turn slot never released.
   *
   * Reaped BEFORE the batch below is chosen, so a turn that is out of attempts is
   * never also counted as requeued. All four writes, the turn, her message and
   * the conversation, happen in one statement through chained CTEs, so a sweeper
   * killed mid statement leaves none of them.
   */
  const reaped = await sql<{ id: string }[]>`
    with dead as (
      select id from course.turns
       where attempts >= ${MAX_ATTEMPTS} and (${stale})
       for update skip locked
    ),
    reap as (
      update course.turns t set status = 'failed', fail_reason = 'crash_loop', finished_at = now()
        from dead where t.id = dead.id
      returning t.id, t.conversation_id, t.user_id
    ),
    said as (
      insert into course.messages (conversation_id, user_id, turn_id, role, content)
      select r.conversation_id, r.user_id, r.id, 'agent', ${TURN_FAILED_MESSAGE} from reap r
    ),
    convo as (
      update course.conversations c set status = 'failed', updated_at = now()
        from reap r where c.id = r.conversation_id and c.user_id = r.user_id
    )
    select id from reap`

  // Counted before the batch is taken and NOT reduced by it: every row counted
  // here is still stale after this sweep, because requeueing sets queued_at to
  // now() and the next sweep will see it again only if nothing ran it. This is
  // the number an alarm reads, so it has to mean "work waiting", not "work this
  // tick declined to do".
  const [count] = await sql<{ count: number }[]>`
    select count(*)::int as count from course.turns
     where (${stale}) and attempts < ${MAX_ATTEMPTS}`

  const rows = await sql<{ id: string }[]>`
    with batch as (
      select id from course.turns
       where (${stale}) and attempts < ${MAX_ATTEMPTS}
       order by coalesce(heartbeat_at, queued_at)
       limit ${limit}
       for update skip locked
    )
    update course.turns t set status = 'queued', queued_at = now()
      from batch where t.id = batch.id
    returning t.id`

  return {
    requeued: rows.map((r) => r.id),
    reaped: reaped.map((r) => r.id),
    stalled: stalled.map((r) => r.id),
    backlog: count!.count,
  }
}
