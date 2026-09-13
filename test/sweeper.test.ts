import { describe, it, expect } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { sweep } from '../src/sweeper.js'
import { MAX_ATTEMPTS } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function convo(sql: postgres.Sql) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  return c!.id as string
}

describeDb('sweep', () => {
  it('requeues a turn whose heartbeat went silent', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status,
                           started_at, heartbeat_at)
        values (${cid}, ${USER}, 'k', 'running',
                now() - interval '10 minutes', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})
      expect(out.requeued).toContain(t!.id)
    })
  })

  // The orphan: the enqueue HTTP call failed, so nothing ever ran this turn.
  it('requeues a turn stuck in queued, which the old sweeper never saw', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status, queued_at)
        values (${cid}, ${USER}, 'k', 'queued', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})
      expect(out.requeued).toContain(t!.id)
    })
  })

  it('does not touch a live turn', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                   started_at, heartbeat_at)
                values (${cid}, ${USER}, 'k', 'running', now(), now())`
      expect((await sweep(sql, {})).requeued).toHaveLength(0)
    })
  })

  it('does not resurrect a parked turn — the money leak', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`update conversations set status='awaiting_user' where id=${cid}`
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                   finished_at, heartbeat_at)
                values (${cid}, ${USER}, 'k', 'done', now() - interval '2 hours',
                        now() - interval '2 hours')`
      expect((await sweep(sql, {})).requeued).toHaveLength(0)
    })
  })

  // CRITICAL 3: a turn at attempts >= MAX_ATTEMPTS can never be reclaimed
  // (claimTurn's own guard), so without reaping it the old sweeper would requeue
  // it forever — alive-looking, never actually worked, its conversation stuck
  // 'working', and the one-active-turn-per-conversation slot permanently held.
  it('fails a turn at MAX_ATTEMPTS with crash_loop and moves its conversation off working', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`update conversations set status = 'working' where id = ${cid}`
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status,
                           attempts, started_at, heartbeat_at)
        values (${cid}, ${USER}, 'k', 'running', ${MAX_ATTEMPTS},
                now() - interval '10 minutes', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})

      expect(out.reaped).toContain(t!.id)
      expect(out.requeued).not.toContain(t!.id)   // NOT requeued

      const [turn] = await sql`select status, fail_reason, finished_at from turns where id = ${t!.id}`
      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('crash_loop')
      expect(turn!.finished_at).not.toBeNull()

      const [c] = await sql`select status from conversations where id = ${cid}`
      expect(c!.status).toBe('failed')
      expect(c!.status).not.toBe('working')
    })
  })

  it('keeps a crash-looping conversation escalated instead of overwriting it to failed', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      await sql`update conversations set status = 'escalated' where id = ${cid}`
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status,
                           attempts, started_at, heartbeat_at)
        values (${cid}, ${USER}, 'k', 'running', ${MAX_ATTEMPTS},
                now() - interval '10 minutes', now() - interval '10 minutes')
        returning id`
      const out = await sweep(sql, {})

      expect(out.reaped).toContain(t!.id)

      const [turn] = await sql`select status, fail_reason from turns where id = ${t!.id}`
      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('crash_loop')

      const [c] = await sql`select status from conversations where id = ${cid}`
      expect(c!.status).toBe('escalated')
    })
  })

  it('does not reap a live turn even at MAX_ATTEMPTS', async () => {
    await withTestDb(async (sql) => {
      const cid = await convo(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status,
                           attempts, started_at, heartbeat_at)
        values (${cid}, ${USER}, 'k', 'running', ${MAX_ATTEMPTS}, now(), now())
        returning id`
      const out = await sweep(sql, {})
      expect(out.reaped).toHaveLength(0)
      const [turn] = await sql`select status from turns where id = ${t!.id}`
      expect(turn!.status).toBe('running')
    })
  })

  it('is bounded and reports the remaining backlog', async () => {
    await withTestDb(async (sql) => {
      for (let i = 0; i < 5; i++) {
        const cid = await convo(sql)
        await sql`insert into turns (conversation_id, user_id, idempotency_key, status,
                                     queued_at)
                  values (${cid}, ${USER}, ${'k' + i}, 'queued',
                          now() - interval '10 minutes')`
      }
      const out = await sweep(sql, { batchSize: 2 })
      expect(out.requeued).toHaveLength(2)
      expect(out.backlog).toBe(5)
    })
  })
})
