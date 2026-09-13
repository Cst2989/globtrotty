import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { handOff, withinTolerance, sameIdentity, ACCEPT_WINDOW_MS } from '../src/tools/cashier.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { decideProposal } from '../src/repo/proposals.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier, type MockConfig } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flight: FlightSearch = { kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false }
const hotel: HotelSearch = { kind: 'hotel', query: 'Faro beach', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2, currency: 'EUR' }
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({ content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage })
const withBudget = (nb: Notebook): Notebook => ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

/** A proposal she can accept, built through the real path against the mock. */
async function seed(sql: postgres.Sql, n: string, mock: Partial<MockConfig> = {}) {
  const userId = `00000000-0000-4000-8000-000000000d${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'h' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const flights = new MockSupplier({ kind: 'flight', now: () => NOW, ...mock })
  const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW, ...mock })
  const fp = { ...flight, flexDays: Number(n) }, hp = { ...hotel, query: hotel.query + n }
  const fi = await flights.search(fp), hi = await hotels.search(hp)
  await recordResults(sql, { conversationId, userId, turnId, params: fp, items: fi })
  await recordResults(sql, { conversationId, userId, turnId, params: hp, items: hi })
  const path = { sql, transport: { create: vi.fn().mockResolvedValue(approve()) }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() }
  const ctx = { conversationId, userId, turnId }
  await runProposalPath(path, ctx, { micros: 0n }, { notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null,
    refs: [{ sourceId: fi[0]!.sourceId, quantity: 1, slot: 'outbound' }, { sourceId: hi[0]!.sourceId, quantity: 1, slot: 'stay' }] })
  const [p] = await sql`select id from proposals where conversation_id = ${conversationId}`
  const deps = { sql, flights, hotels, now: () => NOW.getTime() }
  return { ...ctx, deps, proposalId: p!.id as string, flights, hotels, fi, hi }
}
const accept = (sql: postgres.Sql, s: { proposalId: string; conversationId: string }, at = NOW) =>
  decideProposal(sql, { proposalId: s.proposalId, conversationId: s.conversationId, decision: 'accept', now: at })

describeDb('cashier', () => {
  it('refuses an unknown or foreign proposal', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '01'); const b = await seed(sql, '02')
      await accept(sql, a)
      expect(await handOff(b.deps, b, a.proposalId)).toMatch(/no proposal/i)
      expect(await sql`select 1 from link_clicks`).toHaveLength(0)
    })
  })
  it('refuses until she has accepted, and again after 30 minutes', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/not been accepted/i)
      await accept(sql, s, new Date(NOW.getTime() - ACCEPT_WINDOW_MS - 1000))
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/more than 30 minutes/i)
      expect(await sql`select 1 from link_clicks`).toHaveLength(0)
    })
  })
  it('refuses a rejected proposal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      await decideProposal(sql, { proposalId: s.proposalId, conversationId: s.conversationId, decision: 'reject', now: NOW })
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/rejected/i)
    })
  })
  it('re-quotes every item, mints one link per item, and the reply carries URLs with the tracking ref', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await accept(sql, s)
      const qf = vi.spyOn(s.flights, 'quote'); const qh = vi.spyOn(s.hotels, 'quote')
      const out = await handOff(s.deps, s, s.proposalId)
      expect(qf).toHaveBeenCalledTimes(1); expect(qh).toHaveBeenCalledTimes(1)
      const links = await sql`select item_id, supplier, url, tracking_ref, quoted_minor, currency, turn_id from link_clicks where proposal_id = ${s.proposalId} order by item_id`
      expect(links).toHaveLength(2)
      for (const l of links) {
        expect(out).toContain(l.url as string)
        expect(new URL(l.url as string).searchParams.get('gt_ref')).toBe(l.tracking_ref)
        expect(l.turn_id).toBe(s.turnId)
      }
      expect(out).toMatch(/verified/i)
      const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(6_000n)   // the reviewer's call only; the cashier moved no money
    })
  })
  it.each([['unavailable'], ['gone'], ['throw']] as const)('blocks the whole hand-off when a quote is %s', async (mode) => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06', { quoteMode: mode })
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toMatch(/could not verify/i)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(0)
    })
  })
  it('passes at exactly 0.5% and blocks one basis point over', () => {
    expect(withinTolerance(100_000n, 100_500n)).toBe(true)
    expect(withinTolerance(100_000n, 99_500n)).toBe(true)
    expect(withinTolerance(100_000n, 100_501n)).toBe(false)
    expect(withinTolerance(100_000n, 99_499n)).toBe(false)
  })
  it('blocks a price move past tolerance, naming the item and both prices', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07', { quoteDriftMinor: 5_000n })
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toMatch(/moved/i)
      expect(out).toContain(s.fi[0]!.sourceId)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(0)
    })
  })
  it('blocks a CHEAPER fare whose identity changed', () => {
    const stored = { slot: 'outbound', quantity: 1, sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n', priceMinor: '1000', currency: 'EUR', priceBasis: 'total' as const,
      fetchedAt: NOW.toISOString(), lineTotalMinor: '1000', searchParams: null,
      detail: { kind: 'flight' as const, outbound: { from: 'A', to: 'B', departureLocal: '2026-09-12T08:00:00', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: ['ZZ100'] }, inbound: null, baggage: { personalItem: 0, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 0, selfTransfer: false } }
    const fresh = { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n', price: money(900n, 'EUR'), priceBasis: 'total' as const, fetchedAt: NOW, ttlSeconds: 900, bookingUrl: null,
      detail: { ...stored.detail, outbound: { ...stored.detail.outbound, flightNumbers: ['ZZ101'] } } }
    expect(sameIdentity(stored, fresh)).toBe(false)
    expect(sameIdentity(stored, { ...fresh, detail: stored.detail })).toBe(true)
  })
  it('blocks a same-price quote in a different currency', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      await accept(sql, s)
      vi.spyOn(s.flights, 'quote').mockImplementation(async (id, p) => {
        const r = await MockSupplier.prototype.quote.call(s.flights, id, p)
        return r.status === 'ok' ? { status: 'ok', item: { ...r.item, price: money(r.item.price.minor, 'USD') } } : r
      })
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/currency/i)
    })
  })
  it('discloses instead of verifying when the supplier cannot re-quote, and calls quote zero times', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '09', { mayRequote: false })
      await accept(sql, s)
      const qf = vi.spyOn(s.flights, 'quote')
      const out = await handOff(s.deps, s, s.proposalId)
      expect(qf).not.toHaveBeenCalled()
      expect(out).not.toMatch(/verified/i)
      expect(out).toMatch(/prices move/i)
      expect(out).toMatch(/min ago|minutes ago/i)
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(2)
    })
  })
  it('blocks an item with no stored search to re-run', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '10')
      await accept(sql, s)
      await sql`update proposals set itinerary = jsonb_set(itinerary, '{items,0,searchParams}', 'null') where id = ${s.proposalId}`
      expect(await handOff(s.deps, s, s.proposalId)).toMatch(/could not verify/i)
    })
  })
  it('returns the stored links on a second call and re-quotes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '11')
      await accept(sql, s)
      const first = await handOff(s.deps, s, s.proposalId)
      const qf = vi.spyOn(s.flights, 'quote')
      const second = await handOff(s.deps, s, s.proposalId)
      expect(qf).not.toHaveBeenCalled()
      expect(second).toBe(first)
    })
  })
  it('hands off a shipped_unapproved proposal but repeats the reviewer\'s issues', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '12')
      await sql`update proposals set gate_outcome = 'shipped_unapproved', review_issues = '["the stay is far from the beach"]' where id = ${s.proposalId}`
      await accept(sql, s)
      const out = await handOff(s.deps, s, s.proposalId)
      expect(out).toContain('the stay is far from the beach')
      expect(await sql`select 1 from link_clicks where proposal_id = ${s.proposalId}`).toHaveLength(2)
    })
  })
})
