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
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  toThreadView, firstMessagePerConversation, itineraryItemsLite, newestAlternativePerSourceId,
  dropExpiredAlternatives, newestResultItemPerSourceId, dropExpiredResultItems, cityNamesFor,
  naiveMinutesBetween,
  type ThreadMessage, type AlternativeLite, type ResultItemLite,
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

  // Plan 5, Task 9.
  it('turns a results row into a plain "N shown" marker, never the sourceIds', () => {
    const content = JSON.stringify({
      kind: 'flights',
      query: { from: 'BCN', to: 'HND', outbound: '2026-11-19', inbound: null, adults: 1 },
      sourceIds: ['F1', 'F2', 'F3'],
      assumptions: [],
    })
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'results', content, created_at: 't1' }]

    const view = toThreadView(rows)

    expect(view[0]!.content).toBe('3 flights shown')
    expect(view[0]!.content).not.toContain('F1')
  })

  it('singularises the results marker for exactly one item', () => {
    const content = JSON.stringify({
      kind: 'hotels',
      query: { place: 'Lisbon', outbound: '2026-11-19', inbound: '2026-11-26', adults: 1 },
      sourceIds: ['H1'],
      assumptions: [],
    })
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'results', content, created_at: 't1' }]

    expect(toThreadView(rows)[0]!.content).toBe('1 hotel shown')
  })

  it('falls back to a fixed sentence for a malformed results row, never the raw text', () => {
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'results', content: 'not json', created_at: 't1' }]

    expect(toThreadView(rows)[0]!.content).toBe('Results were recorded')
  })

  it('leaves a choices row unchanged — MessageBubble needs its JSON client-side', () => {
    const content = JSON.stringify({
      questionId: 'destination', question: 'Which city?',
      options: [{ id: 'TYO', label: 'Tokyo' }, { id: 'OSA', label: 'Osaka' }],
    })
    const rows: ThreadMessage[] = [{ id: 'm1', role: 'choices', content, created_at: 't1' }]

    expect(toThreadView(rows)[0]!.content).toBe(content)
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

// Plan 5, Task 9.
describe('newestResultItemPerSourceId', () => {
  const flightPayload = {
    kind: 'flight',
    outbound: {
      from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00',
      stops: 1, route: ['BCN', 'DOH', 'HND'], cabinClass: 'economy', carriers: ['QR'], flightNumbers: ['QR123', 'QR456'],
    },
    inbound: null,
    baggage: { personalItem: 1, cabinBag: 1, checkedBag: 1 },
    totalDurationSeconds: 51_300, // 14h 15m
    selfTransfer: false,
  }
  const hotelPayload = {
    kind: 'hotel', checkIn: '2026-11-19', checkOut: '2026-11-26', nights: 7, rating: 4,
    coordinates: null, offerSource: null,
  }
  const row = (overrides: Record<string, unknown> = {}) => ({
    source_id: 'F1', name: 'Qatar Airways', price_minor: '45600', currency: 'EUR',
    fetched_at: '2026-10-01T10:00:00.000Z', ttl_seconds: 900, payload: flightPayload,
    ...overrides,
  })

  it('maps a flight payload into ResultItemLite, reading stops/airlines/bags/duration/via off it', () => {
    const out = newestResultItemPerSourceId([row()])
    expect(out).toHaveLength(1)
    const item = out[0]!
    expect(item.sourceId).toBe('F1')
    expect(item.name).toBe('Qatar Airways')
    expect(item.flight).toBeDefined()
    expect(item.flight!.outbound).toEqual({
      from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00',
      via: ['DOH'],
      // Resolved server-side, because both tables read off disk and the card is a client
      // component: the stop's city and the carrier's name.
      viaCities: ['Doha'], carriers: ['QR'], carrierNames: ['Qatar Airways'],
      // A one-way's single leg IS the itinerary, so this is the supplier's own exact figure
      // rather than the difference between two naive local clocks.
      durationMinutes: 855,
    })
    expect(item.flight!.inbound).toBeNull()
    expect(item.flight!.stops).toBe(1)
    expect(item.flight!.inboundStops).toBeNull()   // a one-way has only the outbound leg
    expect(item.flight!.airlines).toEqual(['QR'])
    expect(item.flight!.airlineNames).toEqual(['Qatar Airways'])
    expect(item.flight!.bags).toEqual({ personal: 1, cabin: 1, checked: 1 })
    expect(item.flight!.durationMinutes).toBe(855)
    expect(item.flight!.selfTransfer).toBe(false)
    expect(item.hotel).toBeUndefined()
  })

  // Final review, I3: `inboundStops` is what lets `web/filters.ts` judge every leg the way
  // `src/intake/filter.ts` does. `stops` stays the OUTBOUND leg (what `FlightList` prints
  // beside `outbound.via`), so the two are read separately.
  it('reads the inbound leg\'s own stops for a return flight, keeping stops on the outbound', () => {
    const out = newestResultItemPerSourceId([row({
      payload: {
        ...flightPayload,
        inbound: {
          from: 'HND', to: 'BCN', departureLocal: '2026-12-06T09:00:00', arrivalLocal: '2026-12-06T20:00:00',
          stops: 2, route: ['HND', 'DOH', 'MAD', 'BCN'], cabinClass: 'economy', carriers: ['QR'], flightNumbers: ['QR789'],
        },
      },
    })])
    expect(out[0]!.flight!.stops).toBe(1)
    expect(out[0]!.flight!.inboundStops).toBe(2)
    // A return trip has no per-leg figure from the supplier, so each leg's duration is the
    // difference between its own two naive local clocks — see `LegLite.durationMinutes` for the
    // timezone skew that costs, and why the itinerary total is what the Fastest tab sorts on.
    expect(out[0]!.flight!.inbound!.durationMinutes).toBe(11 * 60)
    expect(out[0]!.flight!.outbound.durationMinutes).toBe(27 * 60 + 15)
    expect(out[0]!.flight!.durationMinutes).toBe(855)
    // `airlines` is the union across both legs; each leg still carries its own.
    expect(out[0]!.flight!.inbound!.viaCities).toEqual(['Doha', 'Madrid'])
  })

  it('falls back to the bare code for a stop or a carrier no table knows', () => {
    const out = newestResultItemPerSourceId([row({
      payload: {
        ...flightPayload,
        outbound: { ...flightPayload.outbound, route: ['BCN', 'ZZZ', 'HND'], carriers: ['ZZ'] },
      },
    })])
    expect(out[0]!.flight!.outbound.viaCities).toEqual(['ZZZ'])
    expect(out[0]!.flight!.airlineNames).toEqual(['ZZ'])
  })

  it('defaults an unreadable inbound stops count to 0 rather than dropping the leg', () => {
    const out = newestResultItemPerSourceId([row({
      payload: {
        ...flightPayload,
        inbound: {
          from: 'HND', to: 'BCN', departureLocal: '2026-12-06T09:00:00', arrivalLocal: '2026-12-06T20:00:00',
          route: ['HND', 'BCN'], cabinClass: 'economy', carriers: ['QR'], flightNumbers: ['QR789'],
        },
      },
    })])
    expect(out[0]!.flight!.inboundStops).toBe(0)
  })

  // A supplier name containing a script-shaped string passes through
  // unchanged here: `maskUntrustedText` only neutralises non-printable-ASCII
  // control characters, not `<`/`>`; what actually keeps it from rendering
  // as markup is React's own escaping (pinned in test/web-results-render.test.ts).
  it('does not strip or escape printable-ASCII supplier text (that is the render layer\'s job)', () => {
    const out = newestResultItemPerSourceId([row({ name: '<script>alert(1)</script>' })])
    expect(out[0]!.name).toBe('<script>alert(1)</script>')
  })

  it('keeps the newest row per source_id, given newest-first input', () => {
    const out = newestResultItemPerSourceId([
      row({ source_id: 'A', price_minor: '100', fetched_at: 't2' }),
      row({ source_id: 'A', price_minor: '999', fetched_at: 't1' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.priceMinor).toBe('100')
  })

  it('drops a row whose payload is neither a recognisable flight nor hotel shape', () => {
    expect(newestResultItemPerSourceId([row({ payload: { kind: 'bogus' } })])).toEqual([])
  })

  it('maps a hotel payload into ResultItemLite', () => {
    const out = newestResultItemPerSourceId([row({ source_id: 'H1', payload: hotelPayload })])
    expect(out).toHaveLength(1)
    expect(out[0]!.hotel).toEqual({ rating: 4, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26' })
    expect(out[0]!.flight).toBeUndefined()
  })

  it('returns an empty list for no rows', () => {
    expect(newestResultItemPerSourceId([])).toEqual([])
  })
})

describe('dropExpiredResultItems', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z')
  const item = (overrides: Partial<ResultItemLite> = {}): ResultItemLite => ({
    sourceId: 'A', name: 'n', priceMinor: '1', currency: 'EUR',
    fetchedAt: '2026-09-13T11:50:00.000Z', ttlSeconds: 900, // fetched 10 min ago, ttl 15 min → fresh
    ...overrides,
  })

  it('keeps an id still inside its own ttl', () => {
    expect(dropExpiredResultItems([item()], NOW)).toEqual([item()])
  })

  it('drops an id past its own ttl', () => {
    const expired = item({ fetchedAt: '2026-09-13T11:40:00.000Z', ttlSeconds: 300 }) // 20 min ago, ttl 5 min
    expect(dropExpiredResultItems([expired], NOW)).toEqual([])
  })
})

describe('cityNamesFor', () => {
  it('resolves query.from/to and a defaulted-origin assumption against the place table', () => {
    expect(cityNamesFor({
      kind: 'flights',
      query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2 },
      sourceIds: [], assumptions: [{ field: 'origin', value: 'MAD', reason: 'defaulted' }],
    })).toEqual({ BCN: 'Barcelona', TYO: 'Tokyo', MAD: 'Madrid' })
  })

  it('omits a code the table does not know rather than inventing a name', () => {
    expect(cityNamesFor({
      kind: 'flights',
      query: { from: 'ZZZ', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
      sourceIds: [], assumptions: [],
    })).toEqual({ TYO: 'Tokyo' })
  })

  it('reads nothing out of a hotels row that carries only a place NAME', () => {
    expect(cityNamesFor({
      kind: 'hotels',
      query: { place: 'Tokyo', outbound: '2026-11-20', inbound: '2026-12-06', adults: 2 },
      sourceIds: [], assumptions: [],
    })).toEqual({})
  })
})

describe('naiveMinutesBetween', () => {
  it('reads both times field by field, never through a zoned Date', () => {
    expect(naiveMinutesBetween('2026-11-19T07:05:00', '2026-11-20T10:20:00')).toBe(27 * 60 + 15)
    expect(naiveMinutesBetween('2026-11-19T07:00:00', '2026-11-19T08:30:00')).toBe(90)
  })

  it('clamps a backwards or unreadable pair to zero rather than a negative flight', () => {
    expect(naiveMinutesBetween('2026-11-20T10:20:00', '2026-11-19T07:05:00')).toBe(0)
    expect(naiveMinutesBetween('nonsense', '2026-11-19T07:05:00')).toBe(0)
  })
})
