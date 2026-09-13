import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { buildRevisedRefs } from '../src/tools/revise.js'
import { countPriorGateRuns } from '../src/repo/toolCalls.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightDetail, FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flight: FlightSearch = { kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false }
const hotel: HotelSearch = { kind: 'hotel', query: 'Faro beach', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2, currency: 'EUR' }
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({ content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage })
const withBudget = (nb: Notebook): Notebook => ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000c${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'v' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const fp = { ...flight, flexDays: Number(n) }
  const flights = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(fp)
  const hotels = await new MockSupplier({ kind: 'hotel', now: () => NOW }).search({ ...hotel, query: hotel.query + n })
  await recordResults(sql, { conversationId, userId, turnId, params: fp, items: flights })
  await recordResults(sql, { conversationId, userId, turnId, params: { ...hotel, query: hotel.query + n }, items: hotels })
  const deps = { sql, transport: { create: vi.fn().mockResolvedValue(approve()) }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() }
  const ctx = { conversationId, userId, turnId }
  await runProposalPath(deps, ctx, { micros: 0n }, { notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null,
    refs: [{ sourceId: flights[0]!.sourceId, quantity: 1, slot: 'outbound' }, { sourceId: hotels[0]!.sourceId, quantity: 1, slot: 'stay' }] })
  const [p] = await sql`select id from proposals where conversation_id = ${conversationId}`
  return { ...ctx, deps, flights, hotels, proposalId: p!.id as string }
}

describeDb('revise_component', () => {
  it('swap replaces exactly one slot and keeps the others', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[1]!.sourceId } })
      expect(r).toEqual({ ok: true, parentProposalId: s.proposalId, refs: [
        { sourceId: s.flights[0]!.sourceId, quantity: 1, slot: 'outbound' },
        { sourceId: s.hotels[1]!.sourceId, quantity: 1, slot: 'stay' } ] })
    })
  })

  it('swap of a slot the proposal does not have is a readable refusal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'inbound', sourceId: s.flights[1]!.sourceId } })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toMatch(/inbound/)
    })
  })

  it('refuses a proposal from another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '03'); const b = await seed(sql, '04')
      const r = await buildRevisedRefs(sql, b.conversationId, { proposalId: a.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: b.hotels[1]!.sourceId } })
      expect(r).toEqual({ ok: false, reason: expect.stringMatching(/no proposal/i) })
    })
  })

  it('shift resolves every slot from the corpus when the shifted dates were searched', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      // Search the shifted dates so the corpus holds them.
      const fp = { ...flight, flexDays: 5, departureDate: '2026-09-14', returnDate: '2026-09-21' }
      const hp = { ...hotel, query: hotel.query + '05', checkIn: '2026-09-14', checkOut: '2026-09-21' }
      const f2 = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(fp)
      const h2 = await new MockSupplier({ kind: 'hotel', now: () => NOW }).search(hp)
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: fp, items: f2 })
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: hp, items: h2 })
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'shift', days: 2 } })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.refs.map((x) => x.slot).sort()).toEqual(['outbound', 'stay'])
      // The mock derives identity from index i; item 0 of the shifted search has the same flight numbers as item 0 of the original.
      expect(r.refs.find((x) => x.slot === 'outbound')!.sourceId).toBe(f2[0]!.sourceId)
      expect(r.refs.find((x) => x.slot === 'stay')!.sourceId).toBe(h2[0]!.sourceId)
    })
  })

  it('shift matches the return leg too — a newer batch with only a different inbound flight is not silently substituted', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '10')
      const fp = { ...flight, flexDays: 5, departureDate: '2026-09-14', returnDate: '2026-09-21' }
      const hp = { ...hotel, query: hotel.query + '10', checkIn: '2026-09-14', checkOut: '2026-09-21' }
      const f2 = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(fp)
      const h2 = await new MockSupplier({ kind: 'hotel', now: () => NOW }).search(hp)
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: fp, items: f2 })
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: hp, items: h2 })
      // A second, NEWER batch: same outbound, a DIFFERENT return flight, under
      // different sourceIds. An outbound-only match would pick this row (it is
      // ordered first by fetched_at/id) and silently hand her a return flight
      // she never chose.
      const f2alt = f2.map((item) => {
        const detail = item.detail as FlightDetail
        return { ...item, sourceId: item.sourceId + '-alt',
          detail: { ...detail, inbound: { ...detail.inbound!, flightNumbers: ['ZZ999'] } } }
      })
      await recordResults(sql, { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: fp, items: f2alt })
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'shift', days: 2 } })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.refs.find((x) => x.slot === 'outbound')!.sourceId).toBe(f2[0]!.sourceId)
    })
  })

  it('shift names every slot it could not resolve and calls no supplier', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'shift', days: 3 } })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.reason).toMatch(/outbound/); expect(r.reason).toMatch(/stay/); expect(r.reason).toMatch(/search/i)
    })
  })

  it('a revise after a propose lands at round 1 with its own reviewer row and lineage', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07')
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_p', 'propose_itinerary', 'done')`
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_r', 'revise_component', 'pending')`
      const round = await countPriorGateRuns(sql, s.turnId, 'toolu_r')
      expect(round).toBe(1)
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[2]!.sourceId } })
      if (!r.ok) throw new Error('unreachable')
      const out = await runProposalPath(s.deps, s, { micros: 0n }, { refs: r.refs, notebook: withBudget(emptyNotebook()), round, parentProposalId: r.parentProposalId })
      expect(out).toContain('proposal_id')
      const rows = await sql`select distinct round from gate_results where turn_id = ${s.turnId} order by round`
      expect(rows.map((x) => x.round)).toEqual([0, 1])
      const [child] = await sql`select parent_proposal_id from proposals where conversation_id = ${s.conversationId} and parent_proposal_id is not null`
      expect(child!.parent_proposal_id).toBe(s.proposalId)
    })
  })

  it('counts prior revise_component calls too, not just propose_itinerary', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '09')
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_p', 'propose_itinerary', 'done')`
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_r1', 'revise_component', 'done')`
      await sql`insert into tool_calls (turn_id, call_id, name, status) values (${s.turnId}, 'toolu_r2', 'revise_component', 'pending')`
      expect(await countPriorGateRuns(sql, s.turnId, 'toolu_r2')).toBe(2)
    })
  })

  it('COLLIDES when a revise re-runs the gates at a round already used — the index is load-bearing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      const r = await buildRevisedRefs(sql, s.conversationId, { proposalId: s.proposalId, change: { kind: 'swap', slot: 'stay', sourceId: s.hotels[2]!.sourceId } })
      if (!r.ok) throw new Error('unreachable')
      await expect(runProposalPath(s.deps, s, { micros: 0n }, { refs: r.refs, notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: r.parentProposalId }))
        .rejects.toThrow(/gate_results_one_row_per_gate_per_round/)
    })
  })
})
