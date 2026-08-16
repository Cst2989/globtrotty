import { describe, it, expect } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { sweep } from '../src/sweeper.js'

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
