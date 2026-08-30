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
 *
 * The `running` half of `stale` is a ceiling on how long a worker's claim may
 * last, not on how long its silence may last, until the worker loop exists.
 * Today the only writer of `heartbeat_at` on any live path is `claimTurn`'s own
 * stamp at the moment of the claim; the worker loop that ticks `heartbeat()` on
 * a timer while a step is in flight is not wired up yet. Until it is, an
 * ordinary multi-step planning turn that simply takes longer than
 * HEARTBEAT_STALE seconds to run looks identical, to this arm, to a worker that
 * has gone silent, and it gets requeued out from under the worker still running
 * it. That worker keeps going and pays for every model call it makes after the
 * requeue; the second worker that claims the reissued turn pays again for the
 * same turn, so one press is billed twice. Fixing the cause belongs to the
 * worker loop, not to this file; this arm ships anyway because a turn nobody
 * ever reaps is worse, but a deploy of this tag should expect that cost until
 * the worker loop starts ticking a heartbeat.
 *
 * A turn failed `ambiguous_tool_call` (lesson 3.4) is `failed`, which sits
 * outside both arms of `stale`, so the sweeper never touches it, and never
 * should: the `pending` row it leaves behind in `course.tool_calls` cannot be
 * resolved by retrying the turn. It is an operator step: run `select * from
 * course.tool_calls where status = 'pending'`, decide from the tool's own
 * record whether the call actually landed, and delete the row by hand.
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
   *
   * The conversation write is guarded by `c.status = 'working'`, the same
   * clause the stalled reap above carries, and for the same reason failTurn
   * gives it: a press that trips a ceiling while this turn is still live takes
   * the ceiling branch and sets the conversation `limit_reached` on its own; if
   * this reap then overwrote that to `failed` unconditionally, she would be told
   * the system broke when she was in fact capped.
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
        from reap r where c.id = r.conversation_id and c.user_id = r.user_id and c.status = 'working'
    )
    select id from reap`

  // Counted before the batch is taken and NOT reduced by it. This is the
  // number an alarm reads, so it has to mean "work waiting", not "work this
  // tick declined to do". Requeueing sets queued_at to now(), which is what
  // makes a row NOT stale, for the next QUEUED_STALE seconds; the count still
  // lands on the same backlog across ticks only because QUEUED_STALE (120s) is
  // shorter than the five-minute cron, so a requeued row goes stale again well
  // before the next sweep runs. Move either number and that stops being true.
  const [count] = await sql<{ count: number }[]>`
    select count(*)::int as count from course.turns
     where (${stale}) and attempts < ${MAX_ATTEMPTS}`

  /**
   * The requeue's only write is `status`, `queued_at` and `heartbeat_at`; it
   * does not need to carry the fencing token to do its job. Flipping `status`
   * off `'running'` is enough on its own, because every fenced write in
   * src/repo/turns.ts matches on `attempts = claim.attempts and status =
   * 'running'` together, so the worker that was holding this turn loses its
   * claim the instant this statement commits, and the next claimTurn is what
   * moves the token forward.
   *
   * `attempts` is incremented here too, which changes what the column counts:
   * not "times claimed" but "times tried". Without this a turn nobody ever
   * invokes, a wrong SITE_URL, a rotated WORKER_SHARED_SECRET, tier 3 down, all
   * of which produce zero claims, would sit at attempts = 0 and be requeued
   * forever, holding her live-turn slot shut with no ending the crash arm above
   * could ever reach. `heartbeat_at` is stamped fresh for the same reason
   * releaseForContinuation stamps it fresh: a stale beat left on a `queued` row
   * would sort a turn just handed back to the head of every future batch,
   * forever, by the `order by` below.
   */
  const rows = await sql<{ id: string }[]>`
    with batch as (
      select id from course.turns
       where (${stale}) and attempts < ${MAX_ATTEMPTS}
       order by coalesce(heartbeat_at, queued_at)
       limit ${limit}
       for update skip locked
    )
    update course.turns t set status = 'queued', queued_at = now(), heartbeat_at = now(),
                              attempts = attempts + 1
      from batch where t.id = batch.id
    returning t.id`

  return {
    requeued: rows.map((r) => r.id),
    reaped: reaped.map((r) => r.id),
    stalled: stalled.map((r) => r.id),
    backlog: count!.count,
  }
}
