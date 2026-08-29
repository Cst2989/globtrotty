import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = DEFAULT_LIMITS
// Two OTHER users, whose spend only the global ceiling can see.
const OTHER_A = '22222222-2222-2222-2222-222222222222'
const OTHER_B = '33333333-3333-3333-3333-333333333333'
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
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
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
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
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

  // The global ceiling protects the ACCOUNT, not the user: she has spent nothing
  // at all here, so neither per-user counter could possibly refuse her. Without
  // this check tier 2 would wave a capped account through and the refusal would
  // land one step into the turn instead — after a model call has been paid for.
  it('denies at tier 2 when the global ceiling is reached, though this user spent nothing', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from daily_usage where day = (now() at time zone 'utc')::date`
      const half = (LIMITS.globalCeilingMicros / 2n).toString()
      await sql`insert into daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${half}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${half})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(r.turnId).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
      const [conv] = await sql`select status from conversations where id = ${r.conversationId}`
      expect(conv!.status).toBe('limit_reached')
      // IMPORTANT 5's guarantee holds on this path too: her words are kept.
      const msgs = await sql`select content from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toBe('two weeks in Peru')
    })
  })

  it('still queues the turn one micro BELOW the global ceiling', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from daily_usage where day = (now() at time zone 'utc')::date`
      const a = (LIMITS.globalCeilingMicros / 2n).toString()
      const b = (LIMITS.globalCeilingMicros - LIMITS.globalCeilingMicros / 2n - 1n).toString()
      await sql`insert into daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${a}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${b})`
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
    })
  })
})
