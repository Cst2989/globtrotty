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
const usage = { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const frontVerdict = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', _request_id: 'r1', usage })
const driverText = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r2', usage })

const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) => ({
  sql, transport: { create }, flights: new MockSupplier({ kind: 'flight' }), hotels: new MockSupplier({ kind: 'hotel' }),
  limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(() => {}),
})

describeDb('routeAgent', () => {
  it('front desk then driver in ONE turn: two seats, two ledger rows, one agent message, title set', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'a week in Portugal in September', idempotencyKey: 'k1' })
      const create = vi.fn()
        .mockResolvedValueOnce(frontVerdict({ label: 'new_trip', answer: null, title: 'Portugal, September' }))
        .mockResolvedValueOnce(driverText('September in the Algarve, then. When would you fly?'))
      await runTurn({ sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(),
        deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }, r.turnId!)
      expect(create).toHaveBeenCalledTimes(2)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(new Set(seats.map((s) => s.seat))).toEqual(new Set(['front_desk', 'driver']))
      const [c] = await sql`select desk, title, status, spend_usd_micros from conversations where id = ${r.conversationId}`
      expect(c!.desk).toBe('planning'); expect(c!.title).toBe('Portugal, September'); expect(c!.status).toBe('awaiting_user')
      expect(BigInt(c!.spend_usd_micros as string)).toBe(3_000n)
      const msgs = await sql`select role, content from messages where conversation_id = ${r.conversationId} order by created_at`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toContain('Algarve')
      const [t] = await sql`select spend_usd_micros from turns where id = ${r.turnId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(BigInt(c!.spend_usd_micros as string))
    })
  })
  it('a faq parks at the front desk; the NEXT turn still goes to the front desk', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'do you take payment?', idempotencyKey: 'k2' })
      const create = vi.fn().mockResolvedValue(frontVerdict({ label: 'faq', answer: 'No, you pay the supplier.', title: null }))
      const w = { sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(), deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }
      await runTurn(w, r.turnId!)
      const r2 = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: r.conversationId, message: 'and cancellations?', idempotencyKey: 'k3' })
      await runTurn(w, r2.turnId!)
      expect(create).toHaveBeenCalledTimes(2)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(seats.every((s) => s.seat === 'front_desk')).toBe(true)
    })
  })
  it('a conversation already at planning never sees the front desk', async () => {
    await withTestDb(async (sql) => {
      const r = await submitMessage({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'k4' })
      await sql`update conversations set desk = 'planning' where id = ${r.conversationId}`
      const create = vi.fn().mockResolvedValue(driverText('Hello. Where to?'))
      await runTurn({ sql, limits: DEFAULT_LIMITS, agent: routeAgent(deps(sql, create)), now: () => Date.now(), deadlineMs: () => Date.now() + 600_000, reinvoke: async () => {} }, r.turnId!)
      const seats = await sql`select seat from model_calls where conversation_id = ${r.conversationId}`
      expect(seats.map((s) => s.seat)).toEqual(['driver'])
    })
  })
})
