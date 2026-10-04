// Pass 3, section 1d. `handleRefresh` (src/agents/refresh.ts) is the agent for the fresh turn a
// `refresh` action queues: it re-runs the stored search and writes a NEW corpus row per
// source_id, superseding the prices that had aged out. Same `withTestDb` + `MockSupplier` shape
// as test/agent-choose.test.ts and test/agent-intake.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { handleRefresh, flightParamsFor, hotelParamsFor } from '../src/agents/refresh.js'
import { nextSteps } from '../src/agents/nextSteps.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { ResultsContent } from '../src/results.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

/** The original search, and the moment the refresh happens — an hour later, well past the ttl. */
const THEN = new Date('2026-10-03T12:00:00Z')
const LATER = new Date('2026-10-03T13:00:00Z')

/** Five arbitrary scores for `MockSupplier`'s five items — same reasoning as agent-intake's. */
const RANK_FIXTURE = {
  model: 'jev-test',
  answers: Object.fromEntries(
    [3, 1, 2, 0, 1].map((score, i) => [`o${i}`, { type: 'score', score, confidence: 0.9, probabilities: {} }]),
  ),
  usage: { input_tokens: 350, output_tokens: 120 },
}

function jevResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

const FLIGHT_QUERY: ResultsContent['query'] = {
  from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2,
  cabin: 'premium_economy',
}

const HOTEL_QUERY: ResultsContent['query'] = {
  place: 'Tokyo', country: 'JP', outbound: '2026-11-20', inbound: '2026-12-06', adults: 2,
}

type Seeded = { userId: string; conversationId: string; turnId: string }

async function seed(sql: postgres.Sql, n: string): Promise<Seeded> {
  const userId = `00000000-0000-4000-8000-0000000f10${n}`
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${c!.id}, ${userId}, ${'rf' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}

function ctx(s: Seeded) {
  return {
    conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
    // A refresh reads no transcript at all — it is a button press against a stored row.
    state: { step: 0, messages: [] },
  }
}

function deps(
  sql: postgres.Sql, fetchImpl: ReturnType<typeof vi.fn>,
  suppliers: { flights: MockSupplier; hotels: MockSupplier },
) {
  return {
    sql, transport: { create: vi.fn() }, ...suppliers,
    limits: DEFAULT_LIMITS, now: () => LATER.getTime(), notifier: new LogNotifier(() => {}),
    jev: { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch },
  }
}

function suppliers(now: () => Date) {
  return { flights: new MockSupplier({ kind: 'flight', now }), hotels: new MockSupplier({ kind: 'hotel', now }) }
}

/** The original flights row plus its corpus, written an hour ago. */
async function seedFlights(sql: postgres.Sql, s: Seeded, query = FLIGHT_QUERY): Promise<string[]> {
  const params = flightParamsFor(query)!
  const original = new MockSupplier({ kind: 'flight', now: () => THEN })
  const items = await original.search(params)
  await recordResults(sql, {
    conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params, items,
  })
  const content: ResultsContent = {
    kind: 'flights', query, sourceIds: items.map((i) => i.sourceId), assumptions: [
      { field: 'year', value: '2026', reason: 'year' },
    ],
  }
  await sql`insert into messages (conversation_id, user_id, role, content)
            values (${s.conversationId}, ${s.userId}, 'results', ${JSON.stringify(content)})`
  return items.map((i) => i.sourceId)
}

describe('the supplier params a stored row implies', () => {
  it('rebuilds the flights search from the query, with the cabin in Kiwi\'s own vocabulary', () => {
    expect(flightParamsFor(FLIGHT_QUERY)).toEqual<FlightSearch>({
      kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: '2026-12-06',
      flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'PremiumEconomy',
      currency: 'EUR', maxStops: null, allowSelfTransfer: false,
    })
  })

  it('defaults a row with no stored cabin to economy, and refuses one with no route', () => {
    expect(flightParamsFor({ ...FLIGHT_QUERY, cabin: undefined })!.cabinClass).toBe('Economy')
    expect(flightParamsFor({ ...FLIGHT_QUERY, from: undefined })).toBeNull()
    expect(flightParamsFor({ ...FLIGHT_QUERY, to: undefined })).toBeNull()
  })

  it('rebuilds the hotels search as the SAME query the original search sent, with its gl', () => {
    expect(hotelParamsFor(HOTEL_QUERY, 'EUR')).toEqual<HotelSearch>({
      kind: 'hotel', query: 'hotels in Tokyo, Japan', checkIn: '2026-11-20', checkOut: '2026-12-06',
      adults: 2, currency: 'EUR', countryCode: 'JP',
    })
    // A row written before the hotels pass carries no country: the words still get the
    // `hotels in` framing, and no `gl` is guessed for a market we were never told.
    expect(hotelParamsFor({ ...HOTEL_QUERY, country: undefined }, 'EUR')).toEqual<HotelSearch>({
      kind: 'hotel', query: 'hotels in Tokyo', checkIn: '2026-11-20', checkOut: '2026-12-06',
      adults: 2, currency: 'EUR', countryCode: null,
    })
    // No check-out is no stay to price.
    expect(hotelParamsFor({ ...HOTEL_QUERY, inbound: null }, 'EUR')).toBeNull()
    expect(hotelParamsFor({ ...HOTEL_QUERY, place: undefined }, 'EUR')).toBeNull()
  })
})

describeDb('handleRefresh', () => {
  it('re-runs the stored flights search: a new corpus row per id, a refreshed results row, chips', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const originalIds = await seedFlights(sql, s)
      const sup = suppliers(() => LATER)
      const searchSpy = vi.spyOn(sup.flights, 'search')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse(RANK_FIXTURE))

      const step = await handleRefresh(deps(sql, fetchImpl, sup), ctx(s), { kind: 'flight' })

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Prices refreshed.')
      expect(searchSpy).toHaveBeenCalledTimes(1)
      // The SAME trip, read off the stored row — never re-interpreted.
      expect(searchSpy.mock.calls[0]![0]).toEqual(flightParamsFor(FLIGHT_QUERY))

      // The results row: same query, same assumptions, flagged as a refresh.
      expect(step.attachments!.map((a) => a.role)).toEqual(['results', 'choices'])
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.kind).toBe('flights')
      expect(content.query).toEqual(FLIGHT_QUERY)
      expect(content.assumptions).toEqual([{ field: 'year', value: '2026', reason: 'year' }])
      expect(content.refreshed).toBe(true)
      expect(content.sourceIds).toHaveLength(5)
      expect(step.attachments![1]!.content).toEqual(nextSteps('flights'))

      // Every id now has a NEWER corpus row; the old ones are superseded, never deleted
      // (`tool_results` is append-only, and `loadResults` reads the newest row per source_id).
      const rows = await sql<{ source_id: string; fetched_at: Date }[]>`
        select source_id, fetched_at from tool_results
         where conversation_id = ${s.conversationId} order by source_id, fetched_at`
      expect(rows).toHaveLength(originalIds.length * 2)
      for (const id of originalIds) {
        const mine = rows.filter((r) => r.source_id === id)
        expect(mine).toHaveLength(2)
        expect(mine[0]!.fetched_at.getTime()).toBe(THEN.getTime())
        expect(mine[1]!.fetched_at.getTime()).toBe(LATER.getTime())
      }

      // The re-rank is Jev's, recorded under the same seat intake uses, and nothing else.
      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['rerank'])
      expect(step.costMicros).toBe(BigInt(calls[0]!.cost_micros))
    })
  })

  it('reads the newest UNFILTERED row, so a refresh can bring back what a filter had hidden', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const ids = await seedFlights(sql, s)
      // A narrowed row on top of it, which is what `readLatestResults` would return.
      const filtered: ResultsContent = {
        kind: 'flights', query: { ...FLIGHT_QUERY, adults: 9 }, sourceIds: [ids[0]!],
        assumptions: [], filter: { nonstop: true },
      }
      await sql`insert into messages (conversation_id, user_id, role, content, created_at)
                values (${s.conversationId}, ${s.userId}, 'results', ${JSON.stringify(filtered)}, clock_timestamp())`

      const sup = suppliers(() => LATER)
      const searchSpy = vi.spyOn(sup.flights, 'search')
      const step = await handleRefresh(
        deps(sql, vi.fn().mockResolvedValueOnce(jevResponse(RANK_FIXTURE)), sup), ctx(s), { kind: 'flight' },
      )

      if (step.kind !== 'park') throw new Error('unreachable')
      // The unfiltered row's query (2 adults), not the filtered row's doctored one.
      expect(searchSpy.mock.calls[0]![0]).toEqual(flightParamsFor(FLIGHT_QUERY))
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.sourceIds).toHaveLength(5)
      expect(content.filter).toBeUndefined()
    })
  })

  it('re-runs a stored hotels search, re-ranked the same way the flights list is', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const params = hotelParamsFor(HOTEL_QUERY, 'EUR')!
      const original = new MockSupplier({ kind: 'hotel', now: () => THEN })
      const items = await original.search(params)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params, items,
      })
      const content: ResultsContent = {
        kind: 'hotels', query: HOTEL_QUERY, sourceIds: items.map((i) => i.sourceId), assumptions: [],
      }
      await sql`insert into messages (conversation_id, user_id, role, content)
                values (${s.conversationId}, ${s.userId}, 'results', ${JSON.stringify(content)})`

      const sup = suppliers(() => LATER)
      const hotelSpy = vi.spyOn(sup.hotels, 'search')
      const flightSpy = vi.spyOn(sup.flights, 'search')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse(RANK_FIXTURE))

      const step = await handleRefresh(deps(sql, fetchImpl, sup), ctx(s), { kind: 'hotel' })

      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Prices refreshed.')
      expect(hotelSpy).toHaveBeenCalledTimes(1)
      // The query it re-ran is the one the ORIGINAL search sent, words and market both.
      expect(hotelSpy.mock.calls[0]![0]).toMatchObject({
        kind: 'hotel', query: 'hotels in Tokyo, Japan', countryCode: 'JP',
      })
      expect(flightSpy).not.toHaveBeenCalled()
      // The hotels pass: a stay IS re-ranked now (`rankItems` scores it against the stay
      // preferences), so the refresh pays for one Jev call exactly as a flights refresh does.
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(step.costMicros).toBeGreaterThan(0n)
      const attachment = step.attachments![0]!.content as ResultsContent
      expect(attachment.kind).toBe('hotels')
      expect(attachment.refreshed).toBe(true)
      expect(step.attachments![1]!.content).toEqual(nextSteps('hotels'))
    })
  })

  it('refuses with no model call and no search when there is no stored row of that kind', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      const sup = suppliers(() => LATER)
      const searchSpy = vi.spyOn(sup.flights, 'search')
      const fetchImpl = vi.fn()

      const step = await handleRefresh(deps(sql, fetchImpl, sup), ctx(s), { kind: 'flight' })

      expect(step).toEqual({
        kind: 'park', message: 'I do not have a search to refresh. Tell me the trip again.', costMicros: 0n,
      })
      expect(searchSpy).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  it('says so, with the two chips that can help, when the refreshed search comes back empty', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await seedFlights(sql, s)
      const sup = { ...suppliers(() => LATER), flights: new MockSupplier({ kind: 'flight', count: 0, now: () => LATER }) }

      const step = await handleRefresh(deps(sql, vi.fn(), sup), ctx(s), { kind: 'flight' })

      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Nothing came back this time. Try again in a minute or change the dates.')
      // No `results` attachment: `recordResults` writes nothing for an empty list, so a row
      // would name a corpus that does not exist (M1).
      expect(step.attachments!.map((a) => a.role)).toEqual(['choices'])
      expect(step.attachments![0]!.content).toEqual(nextSteps('zero_flights'))
    })
  })

  it('fails as provider_down when the supplier throws, leaving the old corpus untouched', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const originalIds = await seedFlights(sql, s)
      const sup = suppliers(() => LATER)
      vi.spyOn(sup.flights, 'search').mockRejectedValueOnce(new Error('kiwi down'))

      const step = await handleRefresh(deps(sql, vi.fn(), sup), ctx(s), { kind: 'flight' })

      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('provider_down')
      expect(step.message).toBe('I could not reach the search just now. Please try again in a moment.')
      const rows = await sql`select id from tool_results where conversation_id = ${s.conversationId}`
      expect(rows).toHaveLength(originalIds.length)
    })
  })
})
