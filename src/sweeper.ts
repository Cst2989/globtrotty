import type postgres from 'postgres'
import type { TurnState } from './engine.js'
import { TURN_FAILED_MESSAGE } from './failure-message.js'
import { completeReapedTurn, HEARTBEAT_STALE, MAX_ATTEMPTS } from './repo/turns.js'
import { completeIfLinkEmitted } from './worker.js'

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
  /**
   * Turns out of attempts that had already emitted a booking link and that this
   * walk actually closed, so they are `done` with the hand-off sentence rather
   * than failed. Rule 6 (src/cashier.ts): nothing may tell her a request that
   * DID something did nothing.
   *
   * Closed, not merely selected. A turn whose close threw is logged and left
   * for the next walk, and it is deliberately absent from this list, because
   * this list is what an operator reads to see the rule 6 road being taken.
   */
  handedOff: string[]
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
 * last, not on how long its silence may last, and that distinction only holds
 * because something keeps refreshing `heartbeat_at` WHILE a step runs.
 *
 * Until lesson 3.6, nothing did: the only writer of `heartbeat_at` on any live
 * path was `claimTurn`'s own stamp at the moment of the claim, so an ordinary
 * multi-step planning turn that simply took longer than HEARTBEAT_STALE
 * seconds to run looked identical, to this arm, to a worker that had gone
 * silent, and got requeued out from under the worker still running it; that
 * worker kept going and paid for every model call it made after the requeue,
 * and the second worker that claimed the reissued turn paid again for the
 * same turn, billing one press twice. The requeue also advances `attempts`,
 * and the worker re-invoked for the reissued turn advances it again when it
 * claims, so a live long turn without a ticking heartbeat spent two of
 * MAX_ATTEMPTS for every ninety-second tick it survived rather than one, and
 * could reach the crash arm above, `TURN_FAILED_MESSAGE` and all, in about
 * half the wall clock it otherwise would, while workers were still running it.
 *
 * From lesson 3.6 on, `src/worker.ts`'s loop ticks `heartbeat()` on a timer
 * (`HEARTBEAT_INTERVAL` seconds, src/repo/turns.ts) while a step is in
 * flight, so an ordinary long-running turn keeps refreshing its own
 * `heartbeat_at` and no longer looks like a dead worker to this arm, or to
 * `claimTurn`'s own stale check. Both costs above are closed with it, for any
 * step the worker's own heartbeat can reach: a single agent call that itself
 * runs many model or tool calls (tier 3's whole `turn()` is exactly this) can
 * still outlive its own turn's budget without a SECOND worker's claim ever
 * being at risk from THIS arm; that is a fencing and retry-budget question
 * `src/worker.ts` and `src/retry.ts` answer, not a gap in this sweeper.
 *
 * A turn that already emitted a booking link is NOT reaped. Link emission is
 * the point of no return (src/cashier.ts, rule 6): she may be on a supplier's
 * checkout page, and a row saying `failed, crash_loop` is a row a module 5
 * reader partitioning `course.turns` by `fail_reason` will file as a failure
 * with no links. Such a turn ends `done`, with the hand-off sentence rebuilt
 * from her own `course.link_clicks` rows, and its conversation goes back to
 * `awaiting_user`.
 *
 * It ends that way through `completeIfLinkEmitted` (src/worker.ts), the same
 * function every exit in the worker goes through, rather than through a second
 * copy of the decision written in SQL. Until lesson 4.6's whole-branch fix this
 * arm had that second copy: it reaped the turn like any other and merely stayed
 * QUIET, skipping TURN_FAILED_MESSAGE and parking the conversation, which is a
 * weaker promise than rule 6 states and the one place the rule's own statement
 * of itself was untrue. Rebuilding her sentence in SQL was never possible, and
 * that was the reason for the silence; calling the function that already
 * rebuilds it costs one round trip per reaped turn, and there are at most
 * `batchSize` of them.
 *
 * The two REQUEUE arms still do not read that table, and README.md carries
 * that as a named residual: neither can emit the same link twice, because the
 * cashier refuses a second hand-off of a proposal that already emitted.
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

  // One definition of "stale", composed into the three queries that ask which
  // turns are stale: the crash-loop reap, the backlog count and the batch. A
  // threshold edited in one of three copies is a sweeper that alarms on one set
  // of rows and acts on another. The stalled arm below is deliberately NOT one
  // of the three: it asks a narrower question (a `queued` turn with no user
  // message at all) and carries its own copy of QUEUED_STALE, which
  // test/sweeper.test.ts guards as a copy rather than as this expression.
  //
  // `coalesce(heartbeat_at, queued_at)`, not bare `heartbeat_at`, because
  // 0001 leaves the column nullable and `NULL < x` is NULL: a `running` turn
  // with no beat yet would be invisible to every arm of this sweep, while
  // `claimTurn` (src/repo/turns.ts) reclaims it through the identical
  // expression. Lesson 3.5 shipped the bare comparison and lesson 3.7's
  // whole-branch review caught the disagreement; migration 0009 re-keys
  // `turns_sweeper_running` on the same expression so the index still matches
  // the predicate.
  const stale = sql`
    (status = 'running'
     and coalesce(heartbeat_at, queued_at) < now() - make_interval(secs => ${HEARTBEAT_STALE}))
    or (status = 'queued' and queued_at < now() - make_interval(secs => ${QUEUED_STALE}))`

  /**
   * First, the turn nothing can ever run: `queued`, old enough, and with no user
   * message to run. Module 2's hand-off. The batch below would requeue it, and
   * since that requeue advances `attempts` it would even end: five sweeps
   * later the crash-loop arm reaps it as `crash_loop` and writes her
   * TURN_FAILED_MESSAGE. Diagnosing it here instead costs one sweep rather
   * than five, gives the row the reason that is actually true, and skips a
   * message about something going wrong for a press that was already answered
   * on the same conversation. Its conversation is handed back, and the point
   * of the whole thing is that last part: the partial unique index on one live
   * turn per conversation was holding her thread shut.
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
   * Then the crash loop, in two halves, because a turn that emitted a booking
   * link may not be told it failed.
   *
   * This half is the turns that DID emit. They are taken out of the reap below
   * by the `not exists` in its `dead` set and ended here instead, one round
   * trip each, through the same `completeIfLinkEmitted` src/worker.ts routes
   * every one of its own exits through. `completeReapedTurn` is passed as the
   * closer because this process holds no claim: see src/repo/turns.ts for the
   * one clause that differs from `completeTurn`, and why matching
   * `status = 'running'` alone would miss the common case.
   *
   * `attempts` is carried from the row into the fence, so a turn another
   * sweeper requeued between this select and this write is left alone rather
   * than closed against a stale token.
   *
   * A close that throws is logged inside `completeIfLinkEmitted` and the row is
   * left where it is, to be tried again on the next walk. That is deliberate
   * and it is the one turn this arm can leave alive-looking: the only way the
   * sentence cannot be built is a turn that handed off twice in two currencies,
   * which `sumMoney` (src/money.ts) refuses to total and the cashier refuses to
   * create. Failing it instead would break the rule this half exists to keep.
   * README.md names it beside the other residuals.
   *
   * Such a row is left out of `handedOff` too, which is why the loop below
   * reads `closed` rather than `emitted`: the walk's own result is the one
   * signal an operator has, and a result counting the turn this arm gave up on
   * as completed would describe a world nobody is in.
   *
   * `for update skip locked`, like the two arms above, so a second walk running
   * at the same time as this select takes different rows. It is not the safety
   * net: `sql` here is whatever handle the caller passed, and under the plain
   * pooled handle netlify/functions/sweep.mts uses, the lock lasts the
   * statement rather than the walk. What actually makes a double close safe is
   * the `attempts` fence carried into `completeReapedTurn`, which turns the
   * loser into a FencedError. This narrows the window that puts one on
   * `console.error`, the sweeper's alarm channel, for an ordinary outcome.
   */
  const emitted = await sql<{
    id: string; conversation_id: string; user_id: string; attempts: number; state: TurnState | null
  }[]>`
    select t.id, t.conversation_id, t.user_id, t.attempts, t.state
      from course.turns t
     where t.attempts >= ${MAX_ATTEMPTS} and (${stale})
       and exists (select 1 from course.link_clicks l where l.turn_id = t.id)
     limit ${limit}
       for update skip locked`

  const handedOff: string[] = []
  for (const row of emitted) {
    const { closed } = await completeIfLinkEmitted(
      { sql, now: () => Date.now() },
      {
        turnId: row.id,
        conversationId: row.conversation_id,
        userId: row.user_id,
        attempts: row.attempts,
        state: row.state,
      },
      row.state ?? { step: 0, messages: [] },
      0n,
      completeReapedTurn,
    )
    if (closed) handedOff.push(row.id)
  }

  /**
   * The other half: a turn at MAX_ATTEMPTS that emitted nothing. It can never be
   * claimed again, because claimTurn's own guard refuses it, so without this it
   * bounces between stale `running` and requeued `queued` forever:
   * alive-looking, never worked, its conversation stuck on `working` and its
   * live-turn slot never released.
   *
   * Reaped BEFORE the batch below is chosen, so a turn that is out of attempts is
   * never also counted as requeued. All four writes, the turn, her message, the
   * conversation and the `failed` row on the feed she watches, happen in one
   * statement through chained CTEs, so a sweeper killed mid statement leaves none
   * of them. It said four and listed three from lesson 3.5 until lesson 4.6's
   * whole-branch fix, which corrected the count to three; the fourth write
   * arrives here, so the number goes back to four for the first time honestly.
   * The tags in between keep whichever sentence they were tagged with, because a
   * history that is edited is not one.
   *
   * The `not exists` sits in `dead` rather than on the message insert, which is
   * where it used to sit. That is the whole of B10 in SQL: a turn with a
   * `link_clicks` row is not a candidate for this statement at all now, so it
   * cannot be marked `failed` here, and the message and the conversation no
   * longer have to ask the table a second time each to decide what to write.
   * The subquery is aliased against `t` for a reason worth keeping: bare `id`
   * inside it resolves to `course.link_clicks.id`, not to the turn's.
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
      select t.id from course.turns t
       where t.attempts >= ${MAX_ATTEMPTS} and (${stale})
         and not exists (select 1 from course.link_clicks l where l.turn_id = t.id)
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
    ),
    -- The fourth write, and the reason the docstring's count went back up. A
    -- crash-looped turn is the one ending on this branch that she can be told
    -- about by nobody but the floor walk, so its feed row is written here or
    -- nowhere. recordAgentEvent is deliberately not called instead: that one is
    -- best effort and separate, and this row has to land in the same statement
    -- as the three beside it, or a sweeper killed mid statement leaves a feed
    -- saying a turn failed and a turn that is still running.
    events as (
      insert into course.agent_events (conversation_id, user_id, turn_id, kind, detail)
      select r.conversation_id, r.user_id, r.id, 'failed', 'crash_loop' from reap r
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
   * The requeue writes four columns: `status`, `queued_at`, `heartbeat_at` and
   * `attempts`. Only the first of them is doing the fencing. Every fenced write
   * in src/repo/turns.ts matches on `attempts = claim.attempts and status =
   * 'running'` together, so flipping `status` off `'running'` fails that
   * predicate on its own, whatever the token says; the worker that was holding
   * this turn loses its claim the instant this statement commits, and the next
   * claimTurn is what moves the token forward for the worker that takes over.
   * That is why a requeue never has to read or carry a claim's token to
   * supersede it, and it stays true of the bump below rather than resting on it.
   *
   * The `attempts` increment is here for a different reason, and it changes what
   * the column counts: not "times claimed" but "times tried". Without it a turn
   * nobody ever invokes, a wrong SITE_URL, a rotated WORKER_SHARED_SECRET, tier
   * 3 down, all of which produce zero claims, would sit at attempts = 0 and be
   * requeued forever, holding her live-turn slot shut with no ending the crash
   * arm above could ever reach. See the ceiling paragraph on sweep() for what
   * this bump cost a live long turn before lesson 3.6's worker loop started
   * ticking a heartbeat; today a live turn's own beats keep it out of this
   * arm entirely, so the bump only ever lands on a turn that really is silent.
   * `heartbeat_at` is stamped fresh for the same reason
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
    handedOff,
    stalled: stalled.map((r) => r.id),
    backlog: count!.count,
  }
}
