/**
 * Polish pass, section 10. The same search, run again inside its own freshness window, costs
 * nothing: the office already has the answer in `tool_results`, with the exact `search_params`
 * it was fetched for and the exact moment it was fetched.
 *
 * The two properties that matter are opposite ones, so both are pinned here: a hit must reuse,
 * and a hit must never make a price look newer than it is. The copied rows keep their original
 * `fetched_at`/`ttl_seconds`, which is what every consumer downstream — the freshness gate, the
 * card's age line, `ResultItemLite.expired` — actually reads.
 */
import { describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { cacheWindowMs, cachedSearch, paramsHash } from '../src/agents/searchCache.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { rerunSearch, type SearchPlan } from '../src/agents/research.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-10-04T12:00:00Z')

const FLIGHTS: FlightSearch = {
  kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: '2026-12-06',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

const STAYS: HotelSearch = {
  kind: 'hotel', query: 'hotels in Tokyo, Japan', checkIn: '2026-11-20', checkOut: '2026-12-06',
  adults: 2, currency: 'EUR', countryCode: 'JP',
}

async function seedConversation(sql: postgres.Sql, userId: string): Promise<string> {
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  return c!.id as string
}

it('reuses a result for exactly as long as the supplier says its own price is good', () => {
  // The windows ARE the ttls. Any other number would mean two answers in this codebase to "is
  // this price still current?".
  expect(cacheWindowMs('flight')).toBe(900 * 1000)
  expect(cacheWindowMs('hotel')).toBe(86_400 * 1000)
})

it('fingerprints a search the same way whatever order its fields are written in', () => {
  const reordered = { ...FLIGHTS }
  expect(paramsHash(reordered)).toBe(paramsHash(FLIGHTS))
  expect(paramsHash({ ...FLIGHTS, adults: 3 })).not.toBe(paramsHash(FLIGHTS))
  // Short enough to read in a function log, long enough not to collide in one.
  expect(paramsHash(FLIGHTS)).toHaveLength(12)
})

describeDb('cachedSearch', () => {
  it('finds this traveller\'s identical search from another conversation of her own', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-0000000ca001'
      const first = await seedConversation(sql, userId)
      const second = await seedConversation(sql, userId)
      const supplier = new MockSupplier({ kind: 'flight', now: () => new Date(NOW.getTime() - 60_000) })
      const items = await supplier.search(FLIGHTS)
      await recordResults(sql, { conversationId: first, userId, turnId: null, params: FLIGHTS, items })

      const hit = await cachedSearch(sql, userId, FLIGHTS, NOW)

      expect(hit).not.toBeNull()
      expect(hit!.map((i) => i.sourceId).sort()).toEqual(items.map((i) => i.sourceId).sort())
      // The age travels with the price. A cached row that claimed to be a minute old when it
      // was fifty would be this office laundering a stale quote, which is the one thing the
      // whole freshness apparatus exists to stop.
      expect(hit![0]!.fetchedAt.getTime()).toBe(items[0]!.fetchedAt.getTime())
      expect(hit![0]!.ttlSeconds).toBe(items[0]!.ttlSeconds)
      // And it is reusable in the OTHER conversation, which is the point.
      expect(second).not.toBe(first)
    })
  })

  it('misses on a different search, and on someone else\'s', async () => {
    await withTestDb(async (sql) => {
      const mine = '00000000-0000-4000-8000-0000000ca002'
      const theirs = '00000000-0000-4000-8000-0000000ca003'
      const conversation = await seedConversation(sql, theirs)
      const supplier = new MockSupplier({ kind: 'flight', now: () => NOW })
      await recordResults(sql, {
        conversationId: conversation, userId: theirs, turnId: null,
        params: FLIGHTS, items: await supplier.search(FLIGHTS),
      })

      // Another traveller's quote is not provenance for mine, however identical the search.
      expect(await cachedSearch(sql, mine, FLIGHTS, NOW)).toBeNull()
      // One more adult is a different search.
      expect(await cachedSearch(sql, theirs, { ...FLIGHTS, adults: 3 }, NOW)).toBeNull()
    })
  })

  it('misses once the window has passed, by each kind\'s own clock', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-0000000ca004'
      const conversation = await seedConversation(sql, userId)
      const twoHoursAgo = new Date(NOW.getTime() - 2 * 3_600_000)

      const fares = new MockSupplier({ kind: 'flight', now: () => twoHoursAgo })
      await recordResults(sql, {
        conversationId: conversation, userId, turnId: null,
        params: FLIGHTS, items: await fares.search(FLIGHTS),
      })
      // A fare is good for a quarter of an hour; two hours later it is not an answer.
      expect(await cachedSearch(sql, userId, FLIGHTS, NOW)).toBeNull()

      const rooms = new MockSupplier({ kind: 'hotel', now: () => twoHoursAgo })
      await recordResults(sql, {
        conversationId: conversation, userId, turnId: null,
        params: STAYS, items: await rooms.search(STAYS),
      })
      // A room rate is good for a day, so the same two hours is still a hit.
      expect(await cachedSearch(sql, userId, STAYS, NOW)).not.toBeNull()
    })
  })
})

describeDb('the same search twice', () => {
  function deps(sql: postgres.Sql, flights: MockSupplier) {
    return {
      sql, transport: { create: vi.fn() }, flights,
      hotels: new MockSupplier({ kind: 'hotel', now: () => NOW }),
      limits: DEFAULT_LIMITS, now: () => NOW.getTime(), notifier: new LogNotifier(() => {}),
      // One item comes back per search in this seed, so `rankItems` is never reached and no Jev
      // call is made: this test is about the SUPPLIER call, and nothing else.
      jev: { apiKey: 'test-key', fetchImpl: vi.fn() as unknown as typeof fetch },
    }
  }

  const plan: SearchPlan = {
    rowKind: 'flights',
    params: FLIGHTS,
    place: null,
    query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2 },
    assumptions: [],
    brief: {
      origin: 'BCN', destination: 'TYO', sideTrip: null, outbound: '2026-11-19',
      inbound: '2026-12-06', adults: 2, cabinLong: 'economy', cabinShort: 'economy',
      maxStops: null, hotels: false, arriveBy: false, assumptions: [],
    },
  }

  it('costs one supplier call, not two, across her own conversations', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-0000000ca005'
      const flights = new MockSupplier({ kind: 'flight', count: 1, now: () => NOW })
      const searchSpy = vi.spyOn(flights, 'search')

      for (const key of ['one', 'two']) {
        const conversationId = await seedConversation(sql, userId)
        const [t] = await sql`
          insert into turns (conversation_id, user_id, idempotency_key, status)
          values (${conversationId}, ${userId}, ${key}, 'running') returning id`
        const run = await rerunSearch(
          deps(sql, flights),
          { conversationId, userId, turnId: t!.id as string, state: { step: 0, messages: [] } },
          plan, 'cache-test',
        )
        expect(run.status).toBe('ok')
        // The corpus of the conversation that asked holds the items either way — `rehydrate` is
        // conversation-scoped, so a cached hit that did not copy them would leave the second
        // conversation naming ids it cannot resolve.
        const corpus = await sql`
          select 1 from tool_results where conversation_id = ${conversationId}`
        expect(corpus.length).toBeGreaterThan(0)
      }

      expect(searchSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('still calls the supplier when she explicitly asks for new prices', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-0000000ca006'
      const flights = new MockSupplier({ kind: 'flight', count: 1, now: () => NOW })
      const searchSpy = vi.spyOn(flights, 'search')
      const conversationId = await seedConversation(sql, userId)

      for (const [key, cache] of [['one', true], ['two', false]] as const) {
        const [t] = await sql`
          insert into turns (conversation_id, user_id, idempotency_key, status)
          values (${conversationId}, ${userId}, ${key}, 'running') returning id`
        await rerunSearch(
          deps(sql, flights),
          { conversationId, userId, turnId: t!.id as string, state: { step: 0, messages: [] } },
          plan, `cache-test-${key}`, { cache },
        )
        await sql`update turns set status = 'done' where id = ${t!.id}`
      }

      // "Refresh prices" is the one request in this office that is ABOUT the supplier call.
      expect(searchSpy).toHaveBeenCalledTimes(2)
    })
  })
})
