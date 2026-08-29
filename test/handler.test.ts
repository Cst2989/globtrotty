import { vi } from 'vitest'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { describeDb, withTestDb } from './helpers/db.js'

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
      const result = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: HER_MESSAGE,
      })
      expect(result.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(result.turnId)
      const msgs = await sql`select role, content, turn_id from course.messages where conversation_id = ${result.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe(HER_MESSAGE)
      // Her message names the turn it was queued for, which is how the worker
      // finds it again in lesson 2.2.
      expect(msgs[0]!.turn_id).toBe(result.turnId)
      const [t] = await sql`select status from course.turns where id = ${result.turnId}`
      expect(t!.status).toBe('queued')
      // The conversation row records that a turn is in flight.
      const [c] = await sql`select status from course.conversations where id = ${result.conversationId}`
      expect(c!.status).toBe('working')
    })
  })

  it('keeps writing into the same conversation on a second message', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const first = await submitMessage(d, { userId: USER, conversationId: null, message: 'one' })
      const second = await submitMessage(d, {
        userId: USER, conversationId: first.conversationId, message: 'two',
      })
      expect(second.conversationId).toBe(first.conversationId)
      // By seq, never by created_at: both rows are written inside withTestDb's
      // single transaction and share one transaction_timestamp().
      const msgs = await sql`select content from course.messages where conversation_id = ${first.conversationId} order by seq`
      expect(msgs.map((m) => m.content)).toEqual(['one', 'two'])
    })
  })

  // The turn is durable before invoke runs. A failed invocation is not her
  // problem, but it is still ours, so it is logged rather than swallowed.
  it('still reports queued when the invocation fails, and says so on stderr', async () => {
    await withTestDb(async (sql) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const invoke = vi.fn().mockRejectedValue(new Error('502 from Netlify'))
        const result = await submitMessage(deps(sql, invoke), {
          userId: USER, conversationId: null, message: 'hi',
        })
        expect(result.status).toBe('queued')
        expect(result.turnId).not.toBeNull()
        const [t] = await sql`select status from course.turns where id = ${result.turnId}`
        expect(t!.status).toBe('queued')
        // The failure is reported, not discarded: an operator has to be able to
        // see that nothing picked this turn up.
        expect(logged).toHaveBeenCalledTimes(1)
        expect(String(logged.mock.calls[0]![0])).toContain(result.turnId)
      } finally {
        logged.mockRestore()
      }
    })
  })

  it('denies when the daily ceiling is reached, before spending anything', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi',
      })
      expect(r.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  // The version of this handler that returned on the limit_reached path above
  // the message insert dropped a capped user's words on the floor.
  it('still preserves her message when the ceiling is reached', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const r = await submitMessage(deps(sql), {
        userId: USER, conversationId: null, message: 'a very expensive trip to Japan',
      })
      expect(r.status).toBe('limit_reached')
      const msgs = await sql`select role, content, turn_id from course.messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('a very expensive trip to Japan')
      expect(msgs[0]!.turn_id).toBeNull()      // no turn was opened for it
    })
  })

  // The global ceiling protects the ACCOUNT, not the user: she has spent nothing
  // at all here, so neither per-user counter could possibly refuse her. Without
  // this check tier 2 would wave a capped account through and the refusal would
  // land one step into the turn instead, after a model call has been paid for.
  it('denies at tier 2 when the global ceiling is reached, though this user spent nothing', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from course.daily_usage where day = (now() at time zone 'utc')::date`
      const half = (LIMITS.globalCeilingMicros / 2n).toString()
      await sql`insert into course.daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${half}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${half})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
      })
      expect(r.status).toBe('limit_reached')
      expect(r.turnId).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
      const [conv] = await sql`select status from course.conversations where id = ${r.conversationId}`
      expect(conv!.status).toBe('limit_reached')
      const msgs = await sql`select content from course.messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toBe('two weeks in Peru')
    })
  })

  it('still queues the turn one micro BELOW the global ceiling', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from course.daily_usage where day = (now() at time zone 'utc')::date`
      const a = (LIMITS.globalCeilingMicros / 2n).toString()
      const b = (LIMITS.globalCeilingMicros - LIMITS.globalCeilingMicros / 2n - 1n).toString()
      await sql`insert into course.daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${a}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${b})`
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
    })
  })
})
