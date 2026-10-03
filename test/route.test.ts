import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { routeAgent } from '../src/agents/route.js'
import { runTurn } from '../src/worker.js'
import { submitMessage } from '../src/handler.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '00000000-0000-4000-8000-00000000d001'
const driverText = (text: string) => ({
  content: [{ type: 'text', text }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'r2',
  usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 },
})

/** A minimal, schema-shaped Jev `fetch` stand-in — never a real network call. */
function jevFetch(answers: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ model: 'jev-test', answers, usage: { input_tokens: 500, output_tokens: 200 } }),
  })
}

const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>, fetchImpl: typeof fetch) => ({
  sql, transport: { create }, flights: new MockSupplier({ kind: 'flight' }), hotels: new MockSupplier({ kind: 'hotel' }),
  limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(() => {}),
  jev: { apiKey: 'test-key', fetchImpl },
})

describeDb('routeAgent', () => {
  it('intake runs on the first message, flips the desk to planning, and parks with a choices card', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'a week somewhere nice in September', idempotencyKey: 'k1' })
      const fetchImpl = jevFetch({
        origin: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.6, BCN: 0.3, MAD: 0.1 } },
      }) as unknown as typeof fetch
      const create = vi.fn()
      await runTurn({
        sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create, fetchImpl)), now: () => Date.now(),
        deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {}, notifier: new LogNotifier(() => {}),
      }, r.turnId!)
      // The driver's transport is never touched: intake parked the turn before anything could
      // reach it.
      expect(create).not.toHaveBeenCalled()
      const [c] = await sql`select desk, status from conversations where id = ${r.conversationId}`
      expect(c!.desk).toBe('planning')
      expect(c!.status).toBe('awaiting_user')
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(seats.map((s) => s.seat)).toEqual(['intake'])
      const [choiceRow] = await sql`
        select role from messages where conversation_id = ${r.conversationId} and role = 'choices'`
      expect(choiceRow).toBeDefined()
    })
  })

  it('a conversation already at planning never sees intake — the router classifies, then the driver runs', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'k4' })
      await sql`update conversations set desk = 'planning' where id = ${r.conversationId}`
      const create = vi.fn().mockResolvedValue(driverText('Hello. Where to?'))
      const fetchImpl = jevFetch({
        intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: {} },
      }) as unknown as typeof fetch
      await runTurn({
        sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create, fetchImpl)), now: () => Date.now(),
        deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {}, notifier: new LogNotifier(() => {}),
      }, r.turnId!)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId} order by seat`
      // Task 6: Jev's own `router` call classifies the message BEFORE the driver ever runs — the
      // Haiku front desk is gone from this path entirely (there is no `front_desk` seat here),
      // but the planning desk itself is no longer a free pass straight to the driver either.
      expect(seats.map((s) => s.seat)).toEqual(['driver', 'router'])
      expect(create).toHaveBeenCalledTimes(1)
    })
  })
})
