import { expect, it, describe } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults, rehydrate } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

async function convo(sql: any, n: string) {
  const userId = `00000000-0000-4000-8000-0000000001${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  return { userId, conversationId: c!.id as string }
}

describeDb('tool_results repo', () => {
  it('records a search and rehydrates it losslessly', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '01')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      const n = await recordResults(sql, { conversationId, userId, turnId: null, params, items })
      expect(n).toBe(items.length)

      const got = await rehydrate(sql, conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(items.length)
      const first = got.get(items[0]!.sourceId)!
      expect(first.price.minor).toBe(items[0]!.price.minor)
      expect(first.price.currency).toBe(items[0]!.price.currency)
      expect(first.name).toBe(items[0]!.name)
      expect(first.detail).toEqual(items[0]!.detail)
      expect(first.ttlSeconds).toBe(items[0]!.ttlSeconds)
      expect(first.fetchedAt).toBeInstanceOf(Date)
      expect(first.priceBasis).toBe(items[0]!.priceBasis)
      expect(first.bookingUrl).toBe(items[0]!.bookingUrl)
      expect(first.supplier).toBe(items[0]!.supplier)
      expect(first.kind).toBe(items[0]!.kind)
    })
  })

  // CORRECTION (task-4 dispatch): the brief's version of this test built the
  // re-recorded item as `{ ...item, price: money(...) }`, which spreads
  // `fetchedAt` through UNCHANGED. Its assertion
  // `toBeGreaterThanOrEqual(before.fetchedAt.getTime())` was then trivially
  // true (x >= x) and ALSO true against an `on conflict do nothing`
  // implementation — exactly the implementation this test exists to catch.
  // Fixed by giving the re-recorded item an explicitly later `fetchedAt` and
  // asserting strict `toBeGreaterThan`.
  // CORRECTION (task-1 dispatch): this test used to be named "is idempotent on
  // re-record and refreshes the price and fetched_at" — a title that describes
  // the pre-migration-0011 upsert, which is the bug backlog 2.1 exists to fix.
  // A second `recordResults` call is NOT idempotent: it appends a new row.
  // The old assertions here (newest price/fetchedAt via `rehydrate`) also
  // passed unchanged against an overwrite implementation, since `rehydrate`
  // takes newest-per-id either way — they never actually distinguished
  // append-only from overwrite. Added the row-count assertion below, which
  // does: it is 2 under append-only and would be 1 under the old upsert.
  it('appends a new row on re-record; rehydrate still returns the newest', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '02')
      const [item] = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [item!] })
      const before = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!

      const moved = {
        ...item!,
        price: money(item!.price.minor + 1000n, 'EUR'),
        fetchedAt: new Date(item!.fetchedAt.getTime() + 60_000),
      }
      await expect(recordResults(sql, {
        conversationId, userId, turnId: null, params, items: [moved],
      })).resolves.toBe(1)

      const all = await sql<{ n: number }[]>`
        select count(*)::int as n from tool_results
         where conversation_id = ${conversationId} and source_id = ${item!.sourceId}`
      expect(all[0]!.n).toBe(2)

      const after = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!
      expect(after.price.minor).toBe(before.price.minor + 1000n)
      expect(after.fetchedAt.getTime()).toBeGreaterThan(before.fetchedAt.getTime())
    })
  })

  it('omits ids it has never seen rather than inventing them', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '03')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { conversationId, userId, turnId: null, params, items })
      const got = await rehydrate(sql, conversationId, [items[0]!.sourceId, 'GHOST'])
      expect(got.has(items[0]!.sourceId)).toBe(true)
      expect(got.has('GHOST')).toBe(false)
      expect(got.size).toBe(1)
    })
  })

  it('scopes strictly to one conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await convo(sql, '04')
      const b = await convo(sql, '05')
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, { ...a, turnId: null, params, items })
      // b never searched; asking for a's ids from b's conversation must find nothing.
      const got = await rehydrate(sql, b.conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(0)
    })
  })

  /**
   * A supplier can legitimately return the same native id twice in one response
   * — an itinerary offered under two fare families, a property listed by two
   * OTAs. Before the dedupe, `insert ... on conflict do update` raised
   * `ON CONFLICT DO UPDATE command cannot affect row a second time`: opaque,
   * naming neither the id nor the table, and fatal to the whole turn.
   *
   * Newest wins on `fetchedAt`, not on array position — position is just
   * whatever order the supplier replied in.
   */
  it('dedupes a repeated sourceId within one batch instead of raising a postgres error', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '07')
      const [item] = await new MockSupplier({ kind: 'flight' }).search(params)
      const older = { ...item!, price: money(11_100n, 'EUR'),
                      fetchedAt: new Date('2026-08-16T10:00:00Z') }
      const newer = { ...item!, price: money(22_200n, 'EUR'),
                      fetchedAt: new Date('2026-08-16T11:00:00Z') }

      // Newest LAST in the array, so a naive "last wins" also gets this right...
      await expect(recordResults(sql, {
        conversationId, userId, turnId: null, params, items: [older, newer],
      })).resolves.toBe(1)
      const a = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!
      expect(a.price.minor).toBe(22_200n)

      // ...and newest FIRST, which it does not. This ordering is what pins that
      // the winner is chosen on fetchedAt rather than on position.
      await expect(recordResults(sql, {
        conversationId, userId, turnId: null, params, items: [newer, older],
      })).resolves.toBe(1)
      const b = (await rehydrate(sql, conversationId, [item!.sourceId])).get(item!.sourceId)!
      expect(b.price.minor).toBe(22_200n)
      expect(b.fetchedAt.toISOString()).toBe('2026-08-16T11:00:00.000Z')
    })
  })

  it('still records every DISTINCT id in a batch that also contains a duplicate', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '08')
      const items = await new MockSupplier({ kind: 'flight', count: 3 }).search(params)
      // 4 items in, 3 distinct ids: the dedupe must not swallow the others.
      const n = await recordResults(sql, {
        conversationId, userId, turnId: null, params, items: [...items, items[0]!],
      })
      expect(n).toBe(3)
      const got = await rehydrate(sql, conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(3)
    })
  })

  it('handles an empty id list without a query', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await convo(sql, '06')
      expect((await rehydrate(sql, conversationId, [])).size).toBe(0)
    })
  })

  it('keeps every fetch, and rehydrates the newest per source_id', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '09')
      const older = new Date('2026-08-01T10:00:00Z')
      const newer = new Date('2026-08-02T10:00:00Z')
      const [item] = await new MockSupplier({ kind: 'flight', now: () => older }).search(params)
      const first = { ...item!, price: money(100_00n, 'EUR'), fetchedAt: older }
      const second = { ...item!, price: money(190_00n, 'EUR'), fetchedAt: newer }

      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [first] })
      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [second] })

      // BOTH fetches survive — this is the append-only property.
      const all = await sql<{ n: number }[]>`
        select count(*)::int as n from tool_results
         where conversation_id = ${conversationId} and source_id = ${item!.sourceId}`
      expect(all[0]!.n).toBe(2)

      // The historical price is still readable. This is what the upsert destroyed.
      const prices = await sql<{ price_minor: string }[]>`
        select price_minor from tool_results
         where conversation_id = ${conversationId} and source_id = ${item!.sourceId}
         order by fetched_at asc`
      expect(prices.map((r) => r.price_minor)).toEqual(['10000', '19000'])

      // The gate still sees exactly one item, and it is the newest.
      const got = await rehydrate(sql, conversationId, [item!.sourceId])
      expect(got.size).toBe(1)
      expect(got.get(item!.sourceId)!.price.minor).toBe(190_00n)
      expect(got.get(item!.sourceId)!.fetchedAt.toISOString()).toBe(newer.toISOString())
    })
  })

  it('rehydrates deterministically when two fetches share a fetched_at', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await convo(sql, '10')
      const same = new Date('2026-08-03T10:00:00Z')
      const [item] = await new MockSupplier({ kind: 'flight', now: () => same }).search(params)
      const first = { ...item!, price: money(100_00n, 'EUR'), fetchedAt: same }
      const second = { ...item!, price: money(200_00n, 'EUR'), fetchedAt: same }

      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [first] })
      await recordResults(sql, { conversationId, userId, turnId: null, params, items: [second] })

      // Ten reads must all agree. Without the `id desc` tiebreak this is a coin flip.
      const seen = new Set<string>()
      for (let i = 0; i < 10; i++) {
        const got = await rehydrate(sql, conversationId, [item!.sourceId])
        seen.add(got.get(item!.sourceId)!.price.minor.toString())
      }
      expect(seen.size).toBe(1)
    })
  })
})
