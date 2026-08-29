import { vi } from 'vitest'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = '11111111-1111-1111-1111-111111111111'
const deps = (sql: postgres.Sql, invoke = vi.fn().mockResolvedValue(undefined)) => ({ sql, invoke })

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
})
