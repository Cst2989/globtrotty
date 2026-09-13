import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { reviewOffer, renderOfferForReview, MAX_REVIEW_ROUNDS } from '../src/agents/reviewer.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdictResponse = (v: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_r', usage,
})
const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
  model: 'claude-opus-5', _request_id: 'req_r', usage }

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000a${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'r' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const p = { ...params, flexDays: Number(n) }
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(p)
  await recordResults(sql, { conversationId, userId, turnId, params: p, items })
  const outcome = await runGates(sql, { conversationId, turnId, round: 0, now: NOW,
    refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }],
    notebook: { budget: money(10_000_00n, 'EUR'), window: null, currency: 'EUR' } })
  if (!outcome.ok) throw new Error('seed')
  return { userId, conversationId, turnId, outcome }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('reviewer seat', () => {
  it('sends the reviewer seat with the JSON schema, and records an approving verdict row', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const create = vi.fn().mockResolvedValue(verdictResponse({ approved: true, issues: [] }))
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      expect(r.kind).toBe('verdict')
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict).toEqual({ approved: true, issues: [] })
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.model).toBe('claude-opus-5')
      expect((sent.output_config as Record<string, unknown>).format).toMatchObject({ type: 'json_schema' })
      const [row] = await sql`select passed, detail, round from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(row).toMatchObject({ passed: true, detail: null, round: 0 })
      const [mc] = await sql`select seat, capture_policy, prompt_version, cost_micros from model_calls where turn_id = ${s.turnId}`
      expect(mc).toMatchObject({ seat: 'reviewer', capture_policy: 'full', prompt_version: 'reviewer@1' })
      expect(BigInt(mc!.cost_micros as string)).toBe(r.costMicros)
      expect(r.costMicros).toBe(6_000n)   // 1000*5 + 40*25
    })
  })

  it('reads a REFUSAL as a rejection, never approval', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const r = await reviewOffer(deps(sql, vi.fn().mockResolvedValue(refusal)), s,
        { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict.approved).toBe(false)
      expect(r.verdict.issues[0]).toMatch(/refus/i)
      expect(r.costMicros).toBe(0n)
      const [row] = await sql`select passed from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(row!.passed).toBe(false)
    })
  })

  it.each([
    ['not JSON', verdictResponse('yes')],
    ['wrong shape', verdictResponse({ ok: true })],
    ['approved with issues', verdictResponse({ approved: true, issues: ['x'] })],
    ['no text block', { ...verdictResponse({}), content: [] }],
  ])('reads %s as a rejection with a synthetic issue', async (_, resp) => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const r = await reviewOffer(deps(sql, vi.fn().mockResolvedValue(resp)), s,
        { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      if (r.kind !== 'verdict') throw new Error('unreachable')
      expect(r.verdict.approved).toBe(false)
      expect(r.verdict.issues).toHaveLength(1)
    })
  })

  it('reserves before the call and reconciles to the real cost', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      let during = 0n
      const create = vi.fn().mockImplementation(async () => {
        const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
        during = BigInt(c!.spend_usd_micros as string)
        return verdictResponse({ approved: false, issues: ['stay ends before the flight home'] })
      })
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(during).toBeGreaterThan(0n)
      expect(BigInt(after!.spend_usd_micros as string)).toBe(r.costMicros)
    })
  })

  it('skips the review and refunds when the reservation would cross a ceiling', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const create = vi.fn()
      const r = await reviewOffer(deps(sql, create), s, { items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(), round: 0 })
      expect(r.kind).toBe('skipped_limit')
      expect(create).not.toHaveBeenCalled()
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(after!.spend_usd_micros as string)).toBe(DEFAULT_LIMITS.conversationCeilingMicros)
      const rows = await sql`select 1 from gate_results where turn_id = ${s.turnId} and gate = 'reviewer'`
      expect(rows).toHaveLength(0)
    })
  })

  it('renders every price with its age and never a model-supplied value', () => {
    const items = [{ ref: { sourceId: 'X', quantity: 1, slot: 'outbound' },
      item: { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'BER-FAO', price: money(45_400n, 'EUR'),
        priceBasis: 'total' as const, fetchedAt: new Date(NOW.getTime() - 5 * 60_000), ttlSeconds: 900, bookingUrl: null,
        detail: { kind: 'flight' as const, outbound: { from: 'BER', to: 'FAO', departureLocal: '2026-09-12T08:00:00', arrivalLocal: '2026-09-12T11:30:00', stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', carriers: ['ZZ'], flightNumbers: ['ZZ100'] }, inbound: null, baggage: { personalItem: 2, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 12600, selfTransfer: false },
        searchParams: null }, lineTotal: money(45_400n, 'EUR') }]
    const text = renderOfferForReview(items, money(45_400n, 'EUR'), NOW)
    expect(text).toContain('€454.00')
    expect(text).toMatch(/5 min/)
    expect(text).toContain('ZZ100')
  })

  it('exposes the round bound as a constant of 2', () => { expect(MAX_REVIEW_ROUNDS).toBe(2) })
})
