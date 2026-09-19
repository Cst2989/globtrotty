// Plan 4a, Task 7, fix round 1 (Minor). `web/data.ts`'s two exported
// functions (`listConversations`, `loadThread`) need a real, authenticated,
// RLS-scoped Supabase client to test end-to-end — an owner-seeded
// conversation for user A can't be read back through a Supabase client
// acting as user B without a real session, which this test suite has no way
// to establish. So this tests the two PURE mappings those functions build
// on instead, no DB required: `toThreadView` (the action-row → UI-sentence
// mapping) and `firstMessagePerConversation` (the sidebar's first-line
// dedup rule).
import { describe, expect, it } from 'vitest'
import {
  toThreadView, firstMessagePerConversation, itineraryItemsLite, newestAlternativePerSourceId,
  dropExpiredAlternatives, type ThreadMessage, type AlternativeLite,
} from '../web/data.js'

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444'

describe('toThreadView', () => {
  it('turns an action row into its plain-language sentence, never the JSON', () => {
    const content = JSON.stringify({ action: 'hand_off', proposalId: PROPOSAL_ID })
    const rows: ThreadMessage[] = [
      { id: 'm1', role: 'user', content: 'hi', created_at: 't1' },
      { id: 'm2', role: 'action', content, created_at: 't2' },
    ]

    const view = toThreadView(rows)

    expect(view[0]).toEqual(rows[0])
    expect(view[1]!.content).toBe('You accepted the proposal')
    expect(view[1]!.content).not.toContain(PROPOSAL_ID)
    expect(view[1]!.content).not.toContain('hand_off')
    expect(view[1]!.content).not.toContain('proposalId')
  })

  it('falls back to a fixed sentence for a malformed action row, never the raw text', () => {
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'action', content: 'not json', created_at: 't1' }]

    const view = toThreadView(rows)

    expect(view[0]!.content).toBe('A card action was recorded')
    expect(view[0]!.content).not.toContain('not json')
  })

  it('leaves user and agent rows unchanged', () => {
    const rows: ThreadMessage[] = [
      { id: 'm1', role: 'user', content: 'a week in Lisbon', created_at: 't1' },
      { id: 'm2', role: 'agent', content: 'Sure — when do you want to travel?', created_at: 't2' },
    ]

    expect(toThreadView(rows)).toEqual(rows)
  })
})

describe('firstMessagePerConversation', () => {
  it('picks the first (earliest, given oldest-first input) user message per conversation', () => {
    const rows = [
      { conversation_id: 'c1', content: 'first for c1' },
      { conversation_id: 'c2', content: 'first for c2' },
      { conversation_id: 'c1', content: 'second for c1, must be ignored' },
    ]

    const map = firstMessagePerConversation(rows)

    expect(map.get('c1')).toBe('first for c1')
    expect(map.get('c2')).toBe('first for c2')
    expect(map.size).toBe(2)
  })

  it('returns an empty map for no rows', () => {
    expect(firstMessagePerConversation([]).size).toBe(0)
  })
})

describe('itineraryItemsLite', () => {
  it('trims a real StoredItinerary down to the card fields, with detail: {} yielding dates: null', () => {
    const itinerary = {
      schemaVersion: 1,
      items: [
        {
          slot: 'outbound', quantity: 1, sourceId: 'F1', supplier: 'mock', kind: 'flight', name: 'BER→FAO',
          priceMinor: '12300', currency: 'EUR', priceBasis: 'total', fetchedAt: '2026-09-13T12:00:00.000Z',
          lineTotalMinor: '12300', bookingUrl: null, detail: {}, searchParams: null,
        },
        {
          slot: 'stay', quantity: 1, sourceId: 'H1', supplier: 'mock', kind: 'hotel', name: 'Casa Bela',
          priceMinor: '45600', currency: 'EUR', priceBasis: 'total', fetchedAt: '2026-09-13T12:05:00.000Z',
          lineTotalMinor: '45600', bookingUrl: null, detail: {}, searchParams: null,
        },
      ],
    }
    expect(itineraryItemsLite(itinerary)).toEqual([
      { slot: 'outbound', sourceId: 'F1', kind: 'flight', name: 'BER→FAO', priceMinor: '12300', currency: 'EUR', fetchedAt: '2026-09-13T12:00:00.000Z', dates: null },
      { slot: 'stay', sourceId: 'H1', kind: 'hotel', name: 'Casa Bela', priceMinor: '45600', currency: 'EUR', fetchedAt: '2026-09-13T12:05:00.000Z', dates: null },
    ])
  })

  // Task 8 review, Minor #9: a real FlightDetail/HotelDetail shape yields
  // a human date range, read straight off `detail` rather than the model's
  // (or anyone else's) prose.
  it('reads dates off a real FlightDetail (one-way and round-trip) and HotelDetail', () => {
    const oneWay = itineraryItemsLite({
      items: [{
        slot: 'outbound', sourceId: 'F1', kind: 'flight', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't',
        detail: { kind: 'flight', outbound: { departureLocal: '2026-09-12T08:00:00' }, inbound: null },
      }],
    })
    expect(oneWay[0]!.dates).toBe('2026-09-12')

    const roundTrip = itineraryItemsLite({
      items: [{
        slot: 'outbound', sourceId: 'F1', kind: 'flight', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't',
        detail: {
          kind: 'flight',
          outbound: { departureLocal: '2026-09-12T08:00:00' },
          inbound: { departureLocal: '2026-09-19T14:30:00' },
        },
      }],
    })
    expect(roundTrip[0]!.dates).toBe('2026-09-12 → 2026-09-19')

    const hotel = itineraryItemsLite({
      items: [{
        slot: 'stay', sourceId: 'H1', kind: 'hotel', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't',
        detail: { kind: 'hotel', checkIn: '2026-09-12', checkOut: '2026-09-19' },
      }],
    })
    expect(hotel[0]!.dates).toBe('2026-09-12 → 2026-09-19')
  })

  it('never throws on a shape it does not recognise; drops unreadable items instead', () => {
    expect(itineraryItemsLite(null)).toEqual([])
    expect(itineraryItemsLite({})).toEqual([])
    expect(itineraryItemsLite({ items: 'not an array' })).toEqual([])
    expect(itineraryItemsLite({ items: [{ slot: 'outbound' }] })).toEqual([])
    expect(itineraryItemsLite({
      items: [
        { slot: 'outbound', sourceId: 'F1', kind: 'bogus', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't' },
        { slot: 'stay', sourceId: 'H1', kind: 'hotel', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't' },
      ],
    })).toEqual([
      { slot: 'stay', sourceId: 'H1', kind: 'hotel', name: 'n', priceMinor: '1', currency: 'EUR', fetchedAt: 't', dates: null },
    ])
  })
})

describe('newestAlternativePerSourceId', () => {
  it('keeps the first (newest, given newest-first input) row per source_id', () => {
    const rows = [
      { source_id: 'A', name: 'newer A', price_minor: '100', currency: 'EUR', fetched_at: 't2', ttl_seconds: 900 },
      { source_id: 'B', name: 'B', price_minor: '200', currency: 'EUR', fetched_at: 't2', ttl_seconds: 600 },
      { source_id: 'A', name: 'older A, must be ignored', price_minor: '999', currency: 'EUR', fetched_at: 't1', ttl_seconds: 900 },
    ]
    const out = newestAlternativePerSourceId(rows)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ sourceId: 'A', name: 'newer A', priceMinor: '100', currency: 'EUR', fetchedAt: 't2', ttlSeconds: 900 })
    expect(out[1]).toEqual({ sourceId: 'B', name: 'B', priceMinor: '200', currency: 'EUR', fetchedAt: 't2', ttlSeconds: 600 })
  })

  it('returns an empty list for no rows', () => {
    expect(newestAlternativePerSourceId([])).toEqual([])
  })
})

describe('dropExpiredAlternatives', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z')
  const alt = (overrides: Partial<AlternativeLite> = {}): AlternativeLite => ({
    sourceId: 'A', name: 'n', priceMinor: '1', currency: 'EUR',
    fetchedAt: '2026-09-13T11:50:00.000Z', ttlSeconds: 900, // fetched 10 min ago, ttl 15 min → fresh
    ...overrides,
  })

  it('keeps an id still inside its own ttl', () => {
    expect(dropExpiredAlternatives([alt()], NOW)).toEqual([alt()])
  })

  it('drops an id past its own ttl', () => {
    const expired = alt({ fetchedAt: '2026-09-13T11:40:00.000Z', ttlSeconds: 300 }) // 20 min ago, ttl 5 min
    expect(dropExpiredAlternatives([expired], NOW)).toEqual([])
  })

  it('keeps an id exactly at the boundary', () => {
    const boundary = alt({ fetchedAt: '2026-09-13T11:45:00.000Z', ttlSeconds: 900 }) // fetched+ttl === now
    expect(dropExpiredAlternatives([boundary], NOW)).toEqual([boundary])
  })
})
