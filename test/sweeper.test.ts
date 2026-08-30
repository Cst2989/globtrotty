import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { FencedError, HEARTBEAT_STALE, MAX_ATTEMPTS, claimTurn, heartbeat } from '../src/repo/turns.js'
import { sweep, QUEUED_STALE } from '../src/sweeper.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()

async function conversation(sql: postgres.Sql): Promise<string> {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  return c!.id as string
}

/** A turn nobody is holding, aged into the past by hand. */
async function abandonedTurn(
  sql: postgres.Sql,
  conversationId: string,
  row: { key: string; status: 'queued' | 'running'; attempts?: number; ageSeconds: number },
): Promise<string> {
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key, status, attempts,
                              queued_at, started_at, heartbeat_at)
    values (${conversationId}, ${USER}, ${row.key}, ${row.status}, ${row.attempts ?? 0},
            now() - make_interval(secs => ${row.ageSeconds}),
            case when ${row.status} = 'running' then now() - make_interval(secs => ${row.ageSeconds}) end,
            case when ${row.status} = 'running' then now() - make_interval(secs => ${row.ageSeconds}) end)
    returning id`
  return t!.id as string
}

describeDb('the two abandoned turns module 2 handed over', () => {
  it('a queued turn with no message can never run, and holds her conversation shut', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      await sql`update course.conversations set status = 'working' where id = ${conversationId}`
      // The residual from lesson 2.7: two presses of one key straddling the
      // moment a ceiling trips, and the turn one of them opened never got the
      // message row the other press's key had already claimed.
      const turnId = await abandonedTurn(sql, conversationId, { key: 's0', status: 'queued', ageSeconds: 600 })

      // A worker can claim it, and then finds nothing to run: loadTurnInput
      // joins on the user message that does not exist.
      expect(await claimTurn(sql, turnId)).not.toBeNull()
      const rows = await sql`select m.id from course.messages m where m.turn_id = ${turnId} and m.role = 'user'`
      expect(rows).toHaveLength(0)

      // And she cannot start a new one, because this turn holds the live slot.
      await sql`update course.turns set status = 'queued' where id = ${turnId}`
      const again = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId, message: 'anything at all', idempotencyKey: 's0-retry',
      })
      expect(again.status).toBe('busy')
    })
  })

  it('a turn stranded at running has nothing scheduled to pick it up', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      // The other hand-off: a driver throw during a spend read escapes turn()
      // after claimTurn has already flipped the row to running and stamped its
      // heartbeat, and the invocation ends there. The row is durable and
      // correct, and no timer, queue or retry anywhere in this codebase is
      // going to look at it until that heartbeat goes stale.
      const turnId = await abandonedTurn(sql, conversationId, {
        key: 's1', status: 'running', attempts: 1, ageSeconds: 600,
      })
      const [t] = await sql`select status, attempts, heartbeat_at from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')
      expect(t!.attempts).toBe(1)          // the claim that started it
      expect(t!.heartbeat_at).not.toBeNull()      // the claim's own stamp
    })
  })
})

describeDb('sweep', () => {
  it('requeues a turn whose worker went silent', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w1', status: 'running', attempts: 1, ageSeconds: HEARTBEAT_STALE + 60,
      })
      const out = await sweep(sql)
      expect(out.requeued).toContain(turnId)
      const [t] = await sql`select status from course.turns where id = ${turnId}`
      expect(t!.status).toBe('queued')
    })
  })

  // The row claimTurn can already reclaim (test/lease.test.ts, "reclaims a
  // running turn whose heartbeat was never set"). The sweeper has to agree, or
  // a running turn with no beat is reachable by a claim that nothing ever
  // makes: the running arm's comparison is NULL, the other two arms want
  // 'queued', so nothing requeues it, nothing re-invokes a worker for it, its
  // attempts never move and the crash-loop arm never fires either. It holds
  // turns_one_active_per_conversation shut and her conversation on 'working'
  // with no ending, which is the hole lesson 3.5 exists to close.
  it('requeues a running turn whose heartbeat was never stamped', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      const [t] = await sql`
        insert into course.turns (conversation_id, user_id, idempotency_key, status, attempts,
                                  queued_at, started_at, heartbeat_at)
        values (${cid}, ${USER}, 'w-nobeat', 'running', 1,
                now() - make_interval(secs => ${HEARTBEAT_STALE + 60}),
                now() - make_interval(secs => ${HEARTBEAT_STALE + 60}),
                null)
        returning id`
      const turnId = t!.id as string
      const out = await sweep(sql)
      expect(out.requeued).toContain(turnId)
      const [row] = await sql`select status from course.turns where id = ${turnId}`
      expect(row!.status).toBe('queued')
    })
  })

  it('fences the worker that was holding the turn it requeues', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w10', status: 'running', attempts: 1, ageSeconds: HEARTBEAT_STALE + 60,
      })
      const claim = { turnId, conversationId: cid, userId: USER, attempts: 1, state: null }
      expect((await sweep(sql)).requeued).toContain(turnId)

      // The point of lessons 3.1 and 3.2, from the sweeper's side: the worker
      // that was holding this turn cannot write to it any more. The requeue
      // moves `attempts` as well as `status`, and either one alone would fail
      // the fenced predicate, so a bare throw here would not say which did it.
      // Putting the token back to the claim's own value leaves the status flip
      // as the only difference between this row and the one the claim was
      // taken on, and that is the thing under test: flipping status off
      // 'running' fences on its own, which is why a requeue never has to carry
      // the token.
      const [back] = await sql`update course.turns set attempts = ${claim.attempts}
                                where id = ${turnId} returning attempts, status`
      expect(back!.attempts).toBe(claim.attempts)
      expect(back!.status).toBe('queued')
      await expect(heartbeat(sql, claim)).rejects.toThrow(FencedError)
    })
  })

  // The orphan: the invocation never happened, or died before it claimed
  // anything. The old sweeper shape, which only looked at 'running', never saw
  // this one at all, and it is exactly the turn a driver throw leaves behind.
  it('requeues a turn stranded at queued', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${cid}, ${USER}, null, 'user', 'a week in Portugal')`
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w2', status: 'queued', ageSeconds: QUEUED_STALE + 60,
      })
      await sql`update course.messages set turn_id = ${turnId} where conversation_id = ${cid}`
      expect((await sweep(sql)).requeued).toContain(turnId)
    })
  })

  it('does not touch a live turn', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      const turnId = await abandonedTurn(sql, cid, { key: 'w3', status: 'running', attempts: 1, ageSeconds: 0 })
      const out = await sweep(sql)
      expect(out.requeued).not.toContain(turnId)
      expect(out.reaped).not.toContain(turnId)
    })
  })

  it('does not touch a queued turn younger than the threshold', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      // No message on this row either, which is exactly what the stalled arm's
      // own copy of the threshold would wrongly reap if QUEUED_STALE were
      // dropped from its WHERE: this test is guarding that copy, not the
      // batch's.
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w4', status: 'queued', ageSeconds: QUEUED_STALE - 5,
      })
      const out = await sweep(sql)
      expect(out.requeued).not.toContain(turnId)
      expect(out.stalled).not.toContain(turnId)
    })
  })

  // The money leak. A parked turn is `done` with the conversation awaiting_user
  // (lesson 3.3), so it is out of scope by construction: the sweeper only ever
  // considers queued and running rows, and cannot re-bill a conversation that is
  // simply waiting on her.
  it('does not resurrect a parked turn', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`update course.conversations set status = 'awaiting_user' where id = ${cid}`
      const [t] = await sql`
        insert into course.turns (conversation_id, user_id, idempotency_key, status,
                                  finished_at, heartbeat_at)
        values (${cid}, ${USER}, 'w5', 'done', now() - interval '2 hours', now() - interval '2 hours')
        returning id`
      const out = await sweep(sql)
      // Scoped to this test's own turn, never a count of the whole table:
      // sweep() is global and withTestDb sees every committed row in the
      // database, so an absolute count here would be a test that fails on a
      // machine where somebody ran npm run demo.
      expect(out.requeued).not.toContain(t!.id)
      expect(out.reaped).not.toContain(t!.id)
      expect(out.stalled).not.toContain(t!.id)
      const [after] = await sql`select status from course.turns where id = ${t!.id}`
      expect(after!.status).toBe('done')
    })
  })

  /**
   * A turn at MAX_ATTEMPTS can never be claimed again, because claimTurn's own
   * guard refuses it. Requeueing it forever would leave it alive-looking and
   * never worked, its conversation stuck on 'working', and the one-live-turn
   * slot held against every new thing she types. Reaped, not requeued, and she
   * gets a sentence rather than a spinner: this is the end of the road for the
   * turn a driver throw stranded, once the retries are used up.
   */
  it('fails a turn at the attempt cap with crash_loop, and tells her', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`update course.conversations set status = 'working' where id = ${cid}`
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${cid}, ${USER}, null, 'user', 'a week in Portugal')`
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w6', status: 'running', attempts: MAX_ATTEMPTS, ageSeconds: HEARTBEAT_STALE + 60,
      })
      await sql`update course.messages set turn_id = ${turnId} where conversation_id = ${cid}`

      const out = await sweep(sql)
      expect(out.reaped).toContain(turnId)
      expect(out.requeued).not.toContain(turnId)

      const [t] = await sql`select status, fail_reason, finished_at from course.turns where id = ${turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('crash_loop')
      expect(t!.finished_at).not.toBeNull()

      const [c] = await sql`select status from course.conversations where id = ${cid}`
      expect(c!.status).toBe('failed')      // off 'working': the spinner stops

      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${cid} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe(TURN_FAILED_MESSAGE)

      // 'failed' reads as the most terminal status in this codebase, but
      // submitMessage never reads conversation status at all: the live-turn
      // slot is what gates her, and this reap released it. Mirrors the stalled
      // test below, so TURN_FAILED_MESSAGE's last sentence, "Please send it
      // again", is a tested promise here too.
      const again = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: cid, message: 'anything at all', idempotencyKey: 'w6-retry',
      })
      expect(again.status).toBe('queued')
    })
  })

  it('does not reap a live turn even at the attempt cap', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w7', status: 'running', attempts: MAX_ATTEMPTS, ageSeconds: 0,
      })
      expect((await sweep(sql)).reaped).not.toContain(turnId)
      const [t] = await sql`select status from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')
    })
  })

  /**
   * The turn nobody ever claims: a wrong SITE_URL, a rotated
   * WORKER_SHARED_SECRET, or tier 3 being down, all of which produce exactly
   * zero calls to claimTurn. `attempts` would never move without the requeue
   * itself spending one, and a turn requeued forever at attempts = 0 never
   * reaches crash_loop, holds her live-turn slot shut, and never ends. No
   * claimTurn call anywhere in this test.
   */
  it('a turn nothing ever claims reaches crash_loop once the requeue count is spent', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`update course.conversations set status = 'working' where id = ${cid}`
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w11', status: 'queued', ageSeconds: QUEUED_STALE + 60,
      })
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${cid}, ${USER}, ${turnId}, 'user', 'a week in Portugal')`

      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        expect((await sweep(sql)).requeued).toContain(turnId)
        await sql`update course.turns
                     set queued_at = now() - make_interval(secs => ${QUEUED_STALE + 60})
                   where id = ${turnId}`
      }

      const out = await sweep(sql)
      expect(out.reaped).toContain(turnId)
      const [t] = await sql`select status, fail_reason, attempts from course.turns where id = ${turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('crash_loop')
      expect(t!.attempts).toBe(MAX_ATTEMPTS)      // spent by the requeue, not by a claim
      const [c] = await sql`select status from course.conversations where id = ${cid}`
      expect(c!.status).toBe('failed')
    })
  })

  /**
   * Module 2's first hand-off, closed. A queued turn with no user message can
   * never be run by anything: loadTurnInput joins on that message and finds
   * nothing, so requeueing it would be an infinite floor walk. It is reaped as
   * `stalled` and, unlike a crash loop, she is told nothing, because the press
   * that won her key already wrote her sentence and already got, or will get, an
   * answer. What matters is that the live-turn slot is released.
   */
  it('reaps a queued turn with no message and gives her conversation back', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`update course.conversations set status = 'working' where id = ${cid}`
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w8', status: 'queued', ageSeconds: QUEUED_STALE + 60,
      })

      const out = await sweep(sql)
      expect(out.stalled).toContain(turnId)
      expect(out.requeued).not.toContain(turnId)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('stalled')
      const [c] = await sql`select status from course.conversations where id = ${cid}`
      expect(c!.status).toBe('active')
      const msgs = await sql`select id from course.messages where conversation_id = ${cid}`
      expect(msgs).toHaveLength(0)          // nothing was invented to say

      // The point of all of it: she can start a turn again.
      const next = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: cid, message: 'anything at all', idempotencyKey: 'w8-next',
      })
      expect(next.status).toBe('queued')
    })
  })

  /**
   * The same turn, one invocation later. From lesson 3.1 tier 3 claims before it
   * loads, so a messageless queued turn's first invocation flips it to `running`
   * and then finds nothing to run. The stalled arm only looks at `queued`, so
   * this one takes two ticks: the batch requeues it, and the next sweep
   * diagnoses it. Two ticks rather than one, and no third state to handle.
   */
  it('reaps a messageless turn a worker already claimed, on the second tick', async () => {
    await withTestDb(async (sql) => {
      const cid = await conversation(sql)
      await sql`update course.conversations set status = 'working' where id = ${cid}`
      const turnId = await abandonedTurn(sql, cid, {
        key: 'w8b', status: 'running', attempts: 1, ageSeconds: HEARTBEAT_STALE + 60,
      })

      const first = await sweep(sql)
      expect(first.requeued).toContain(turnId)
      expect(first.stalled).not.toContain(turnId)

      // Requeueing set queued_at to now(), so it has to age again before the
      // stalled arm can see it. Backdating is what five minutes of real cron
      // does for free.
      await sql`update course.turns
                   set queued_at = now() - make_interval(secs => ${QUEUED_STALE + 60})
                 where id = ${turnId}`

      const second = await sweep(sql)
      expect(second.stalled).toContain(turnId)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('stalled')
      const [c] = await sql`select status from course.conversations where id = ${cid}`
      expect(c!.status).toBe('active')      // her slot is back either way
    })
  })

  it('is bounded, and reports the backlog it did not get to', async () => {
    await withTestDb(async (sql) => {
      const ids: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const cid = await conversation(sql)
        const turnId = await abandonedTurn(sql, cid, {
          key: `w9-${i}`, status: 'queued', ageSeconds: QUEUED_STALE + 60,
        })
        await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                  values (${cid}, ${USER}, ${turnId}, 'user', 'a week in Portugal')`
        ids.push(turnId)
      }
      const out = await sweep(sql, { batchSize: 2 })
      expect(out.requeued).toHaveLength(2)
      // At most two of them are ours, which is the bound the batch size buys.
      // The five above guarantee the batch is full, so the length is exact;
      // which rows filled it is not ours to assert, because sweep() is global.
      expect(out.requeued.filter((id) => ids.includes(id)).length).toBeLessThanOrEqual(2)
      // Every one of the five is still stale, including the two just requeued:
      // the count is what an alarm reads, so it must not shrink because one
      // sweep happened to touch a row.
      expect(out.backlog).toBeGreaterThanOrEqual(5)
    })
  })
})
