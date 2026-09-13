import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { vi } from 'vitest'
import { newConversation, turn } from '../src/conversation.js'
import { loadDesk } from '../src/desks.js'
import { costMicros } from '../src/pricing.js'
import { memorySink, pgSink } from '../src/repo/model-calls.js'
import { SEATS } from '../src/seats.js'
import { mockRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'

// Fresh per run: the fixed literal is the id the scripts commit real rows for,
// and those rows outlive a rolled-back transaction for the rest of the UTC day.
const USER = randomUUID()
// The cheap replies name the seat that actually answered them, so a row's
// model_returned is truthful rather than defaulting to textMessage's own
// model and quietly disagreeing with what was requested (that disagreement is
// test/alias-echo.test.ts's whole subject; here it would just be noise).
const label = textMessage('{"label":"new_trip"}', { model: SEATS.cheap.model })
const requirements = textMessage('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}', { model: SEATS.cheap.model })
const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const answer = textMessage('Two hotels near the beach, both with a crib.')

// test/model/fake.ts's default usage, shared by every reply above (none
// overrides it): the same object prices every row in this file.
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** A postgres.Sql stand-in that fails before it ever reaches a network, for a test with no database. */
function throwingSql(): postgres.Sql {
  return (() => {
    throw new Error('connection refused')
  }) as unknown as postgres.Sql
}

describe('a recorded turn', () => {
  it('writes one row per model call, on the seat that made it', async () => {
    const sink = memorySink()
    const client = fakeClient([label, requirements, search, answer])
    await turn(newConversation(), HER_MESSAGE, client, mockRunner(), { record: sink })

    expect(sink.calls).toHaveLength(4)
    // Classification and extraction are cheap-seat calls; the loop runs on the driver.
    expect(sink.calls.map((c) => c.seat)).toEqual(['cheap', 'cheap', 'driver', 'driver'])

    // Named, not counted: classify, extract and the planning desk are three
    // different prompts, and the loop's two calls share the desk's one
    // prompt rather than landing on three distinct values by chance.
    const [classifyVersion, extractVersion, firstLoopVersion, secondLoopVersion] = sink.calls.map((c) => c.promptVersion)
    expect(classifyVersion).not.toBe(extractVersion)
    expect(classifyVersion).not.toBe(firstLoopVersion)
    expect(extractVersion).not.toBe(firstLoopVersion)
    expect(secondLoopVersion).toBe(firstLoopVersion)
    expect(firstLoopVersion).toBe(loadDesk('planning').promptVersion)

    for (const call of sink.calls) {
      expect(call.costMicros).toBeGreaterThan(0n)
      expect(call.usage.input_tokens).toBeGreaterThan(0)
      // A fake call resolves in well under a second; a latency this large
      // would mean the clock is bracketing something other than this one call.
      expect(call.latencyMs).toBeLessThan(1000)
    }
  })

  it('keeps the turn when the sink fails to write, and logs the failure with the turn id', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const turnId = 'turn-that-was-already-paid-for'
      const record = pgSink(throwingSql(), { userId: USER, conversationId: null, turnId })
      const client = fakeClient([label, requirements, search, answer])
      const result = await turn(newConversation(), HER_MESSAGE, client, mockRunner(), { record })

      // The model calls already happened and were already paid for; a row
      // that fails to write must not take a finished turn down with it.
      expect(result.outcome).toBe('done')
      expect(logged).toHaveBeenCalled()
      expect(String(logged.mock.calls[0]![0])).toContain(turnId)
    } finally {
      logged.mockRestore()
    }
  })
})

describeDb('pgSink', () => {
  it('writes the four token counts and the cost against her turn', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: HER_MESSAGE, idempotencyKey: 'calls-1',
      })
      const record = pgSink(sql, {
        userId: USER, conversationId: submitted.conversationId, turnId: submitted.turnId!,
      })
      const client = fakeClient([label, requirements, search, answer])
      const result = await turn(newConversation(submitted.conversationId), HER_MESSAGE, client,
        mockRunner(), { record })

      const rows = await sql`select * from course.model_calls
                              where conversation_id = ${submitted.conversationId}
                              order by seq`
      expect(rows).toHaveLength(4)

      const cheapCost = costMicros(SEATS.cheap.model, USAGE)
      const driverCost = costMicros(SEATS.driver.model, USAGE)
      const planningVersion = loadDesk('planning').promptVersion

      // Column by column, against the fixture's usage and the seat prices, not
      // just "the column names exist": a transposed pair (model_requested and
      // model_returned, or either token pair) fails one of these rather than
      // passing the whole suite.
      const expectCheapRow = (row: (typeof rows)[number]) => {
        expect(row.seat).toBe('cheap')
        expect(row.model_requested).toBe(SEATS.cheap.model)
        expect(row.model_returned).toBe(SEATS.cheap.model)
        expect(Number(row.input_tokens)).toBe(USAGE.input_tokens)
        expect(Number(row.output_tokens)).toBe(USAGE.output_tokens)
        expect(Number(row.cache_creation_input_tokens)).toBe(0)
        expect(Number(row.cache_read_input_tokens)).toBe(0)
        expect(BigInt(row.cost_micros)).toBe(cheapCost)
        // The seat's own settings, written from the seat rather than from three
        // fields beside it: null effort stays null, and does not become the
        // string 'null' or the driver's 'high'.
        expect(row.effort).toBeNull()
        expect(Number(row.max_tokens)).toBe(SEATS.cheap.maxTokens)
        expect(row.model_config_id).toBe(SEATS.cheap.modelConfigId)
      }
      const expectDriverRow = (row: (typeof rows)[number]) => {
        expect(row.seat).toBe('driver')
        expect(row.model_requested).toBe(SEATS.driver.model)
        expect(row.model_returned).toBe(SEATS.driver.model)
        expect(Number(row.input_tokens)).toBe(USAGE.input_tokens)
        expect(Number(row.output_tokens)).toBe(USAGE.output_tokens)
        expect(Number(row.cache_creation_input_tokens)).toBe(0)
        expect(Number(row.cache_read_input_tokens)).toBe(0)
        expect(BigInt(row.cost_micros)).toBe(driverCost)
        expect(row.prompt_version).toBe(planningVersion)
        expect(row.effort).toBe('high')
        expect(Number(row.max_tokens)).toBe(SEATS.driver.maxTokens)
        // The drift anchor. model_requested and model_returned are the same
        // string here and would stay the same string across a weights swap;
        // this column is the one that would not.
        expect(row.model_config_id).toBe(SEATS.driver.modelConfigId)
      }
      expectCheapRow(rows[0]!)
      expectCheapRow(rows[1]!)
      expectDriverRow(rows[2]!)
      expectDriverRow(rows[3]!)
      // classify and extract share a seat but not a prompt, so their rows
      // must not share a prompt_version either.
      expect(rows[0]!.prompt_version).not.toBe(rows[1]!.prompt_version)
      expect(rows.every((r) => r.turn_id === submitted.turnId)).toBe(true)

      // The question the system could not answer before this lesson: what did
      // her turn cost. The rows and the bill must agree exactly, by
      // construction, not merely both be positive.
      const [total] = await sql`select sum(cost_micros)::text as micros from course.model_calls
                                 where turn_id = ${submitted.turnId}`
      expect(BigInt(total!.micros)).toBe(result.costMicros)
    })
  })
})
