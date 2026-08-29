import { newConversation, turn } from '../src/conversation.js'
import { memorySink, pgSink } from '../src/repo/model-calls.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'

const USER = '11111111-1111-1111-1111-111111111111'
const label = textMessage('{"label":"new_trip"}')
const requirements = textMessage('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}')
const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const answer = textMessage('Two hotels near the beach, both with a crib.')

describe('a recorded turn', () => {
  it('writes one row per model call, on the seat that made it', async () => {
    const sink = memorySink()
    const client = fakeClient([label, requirements, search, answer])
    await turn(newConversation(), HER_MESSAGE, client, mockRunner(new MockSupplier()), { record: sink })

    expect(sink.calls).toHaveLength(4)
    // Classification and extraction are cheap-seat calls; the loop runs on the driver.
    expect(sink.calls.map((c) => c.seat)).toEqual(['cheap', 'cheap', 'driver', 'driver'])
    expect(new Set(sink.calls.map((c) => c.promptVersion)).size).toBe(3)
    for (const call of sink.calls) {
      expect(call.costMicros).toBeGreaterThan(0n)
      expect(call.usage.input_tokens).toBeGreaterThan(0)
      expect(call.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describeDb('pgSink', () => {
  it('writes the four token counts and the cost against her turn', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {} }, {
        userId: USER, conversationId: null, message: HER_MESSAGE,
      })
      const record = pgSink(sql, {
        userId: USER, conversationId: submitted.conversationId, turnId: submitted.turnId,
      })
      const client = fakeClient([label, requirements, search, answer])
      await turn(newConversation(submitted.conversationId), HER_MESSAGE, client,
        mockRunner(new MockSupplier()), { record })

      const rows = await sql`select * from course.model_calls
                              where conversation_id = ${submitted.conversationId}
                              order by seq`
      expect(rows).toHaveLength(4)
      // The two model columns are separate columns, which is the only reason a
      // row can ever hold a disagreement between what we asked for and what
      // answered. test/alias-echo.test.ts is about why they usually agree.
      expect(Object.keys(rows[0]!)).toEqual(
        expect.arrayContaining(['model_requested', 'model_returned']),
      )
      expect(rows[0]!.seat).toBe('cheap')
      expect(rows[0]!.model_requested).toBe('claude-haiku-4-5-20251001')
      expect(rows[2]!.seat).toBe('driver')
      expect(rows[2]!.model_requested).toBe('claude-opus-5')
      expect(Number(rows[0]!.input_tokens)).toBeGreaterThan(0)
      expect(rows.every((r) => BigInt(r.cost_micros) > 0n)).toBe(true)
      expect(rows.every((r) => r.turn_id === submitted.turnId)).toBe(true)

      // The question the system could not answer before this lesson.
      const [total] = await sql`select sum(cost_micros)::text as micros from course.model_calls
                                 where turn_id = ${submitted.turnId}`
      expect(BigInt(total!.micros)).toBeGreaterThan(0n)
    })
  })
})
