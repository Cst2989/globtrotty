import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = DEFAULT_LIMITS
const deps = (sql: postgres.Sql, invoke = vi.fn().mockResolvedValue(undefined)) => ({
  sql, limits: LIMITS, invoke,
})

describeDb('submitMessage', () => {
  it('creates a conversation, a message, and a queued turn, then invokes', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null,
        message: 'a week in Portugal in September', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
      const msgs = await sql`select * from messages where conversation_id = ${r.conversationId}`
      expect(msgs[0]!.role).toBe('user')
    })
  })

  it('returns the same turn for a duplicate idempotency key', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'same',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'hi', idempotencyKey: 'same',
      })
      expect(b.status).toBe('duplicate')
      expect(b.turnId).toBe(a.turnId)
    })
  })

  it('refuses a second turn while one is in flight', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'one', idempotencyKey: 'i1',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'two', idempotencyKey: 'i2',
      })
      expect(b.status).toBe('busy')
    })
  })

  it('denies when the daily ceiling is reached, before spending anything', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER}, current_date, ${LIMITS.dailyCeilingMicros.toString()})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  // IMPORTANT 5: the old code returned on the limit_reached path ten lines above
  // the message insert, so a capped user's words were silently dropped.
  it('still preserves her message when the ceiling is reached', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER}, current_date, ${LIMITS.dailyCeilingMicros.toString()})`
      const r = await submitMessage(deps(sql), {
        userId: USER, conversationId: null, message: 'a very expensive trip to Japan',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      const msgs = await sql`select role, content from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('a very expensive trip to Japan')
    })
  })

  // The turn is durable before invoke runs; the sweeper is the backstop.
  it('still reports queued when the invocation fails', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockRejectedValue(new Error('502 from Netlify'))
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      const [t] = await sql`select status from turns where id = ${r.turnId}`
      expect(t!.status).toBe('queued')
    })
  })
})
