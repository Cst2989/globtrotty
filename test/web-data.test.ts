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
  dropExpiredAlternatives, newestResultItemPerSourceId, isExpired, freshnessOf, cityNamesFor,
  naiveMinutesBetween, skeletonMode, describeResultsForUi,
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
          slot: 'outbound', quantity: 1, sourceId: 'F1', supplier: 'mock', kind: 'flight', name: 'BER-FAO',
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
      { slot: 'outbound', sourceId: 'F1', kind: 'flight', name: 'BER-FAO', priceMinor: '12300', currency: 'EUR', fetchedAt: '2026-09-13T12:00:00.000Z', dates: null },
      { slot: 'stay', sourceId: 'H1', kind: 'hotel', name: 'Casa Bela', priceMinor: '45600', currency: 'EUR', fetchedAt: '2026-09-13T12:05:00.000Z', dates: null },
    ])
  })

  /**
   * The pinned summary is read by her, not by the model, so a name reaches it through
   * `maskDisplayName` — which keeps letters of any script and removes everything that is not
   * part of a name. The arrow is one of those: `maskDisplayName`'s allowed punctuation is
   * punctuation, and an arrow is a symbol. Nothing real loses by it (`src/supplier/kiwi.ts`
   * builds its names as `BER-FAO`, with a hyphen), and this is the pin that would notice if a
   * supplier started sending one.
   */
  it('masks the name for display: letters of any script kept, symbols and markup removed', () => {
    const item = (name: string) => ({
      items: [{
        slot: 'stay', sourceId: 'H1', kind: 'hotel', name, priceMinor: '1', currency: 'EUR',
        fetchedAt: 't', detail: {},
      }],
    })
    expect(itineraryItemsLite(item('\u30b7\u30c6\u30a3\u30d1\u30fc\u30eb'))[0]!.name).toBe('\u30b7\u30c6\u30a3\u30d1\u30fc\u30eb')
    expect(itineraryItemsLite(item('BER\u2192FAO'))[0]!.name).toBe('BERFAO')
    expect(itineraryItemsLite(item('<b>Casa</b>'))[0]!.name).toBe('bCasa/b')
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
/** Inside every fixture row's own ttl below, so `expired` is false unless a case says otherwise. */
const NOW_ROWS = new Date('2026-10-01T10:05:00.000Z')

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
  /** A row written BEFORE the hotels pass: four fields, none of the twelve a card now reads. */
  const hotelPayload = {
    kind: 'hotel', checkIn: '2026-11-19', checkOut: '2026-11-26', nights: 7, rating: 4,
    coordinates: null, offerSource: null,
  }

  /** A row written after it, with every field the card renders — and three it must refuse. */
  const richHotelPayload = {
    ...hotelPayload,
    propertyType: 'hotel', stars: 3, reviews: 350, locationRating: 4.4,
    images: [
      'https://lh3.googleusercontent.com/ok.png',
      'javascript:alert(1)',
      'http://evil.test/a.png',
    ],
    amenities: ['Free Wi-Fi', 'Parking'],
    essentials: ['Entire apartment'],
    nearby: [{ name: 'Haneda Airport', minutes: 28, by: 'Taxi' }, { bogus: true }],
    pricePerNightMinor: '7000', distanceKm: 3.2,
  }
  const row = (overrides: Record<string, unknown> = {}) => ({
    source_id: 'F1', name: 'Qatar Airways', price_minor: '45600', currency: 'EUR',
    fetched_at: '2026-10-01T10:00:00.000Z', ttl_seconds: 900, payload: flightPayload,
    ...overrides,
  })

  it('maps a flight payload into ResultItemLite, reading stops/airlines/bags/duration/via off it', () => {
    const out = newestResultItemPerSourceId([row()], NOW_ROWS)
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
    })], NOW_ROWS)
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
    })], NOW_ROWS)
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
    })], NOW_ROWS)
    expect(out[0]!.flight!.inboundStops).toBe(0)
  })

  // The hotels pass changed this. A NAME now goes through `maskDisplayName`, which REMOVES the
  // angle brackets outright instead of letting them through as printable ASCII — strictly more
  // than React's own escaping needs, and it is what lets the same function keep Japanese letters.
  // Every other string read off a payload is still `maskUntrustedText`'s, markup and all, because
  // the render layer is what makes those safe (pinned in test/web-results-render.test.ts).
  it('strips markup from a NAME, and leaves other printable-ASCII supplier text alone', () => {
    const out = newestResultItemPerSourceId([row({
      name: '<script>alert(1)</script>',
      payload: { ...flightPayload, outbound: { ...flightPayload.outbound, from: '<b>BCN</b>' } },
    })], NOW_ROWS)
    expect(out[0]!.name).toBe('scriptalert(1)/script')
    expect(out[0]!.flight!.outbound.from).toBe('<b>BCN</b>')
  })

  it('keeps the newest row per source_id, given newest-first input', () => {
    const out = newestResultItemPerSourceId([
      row({ source_id: 'A', price_minor: '100', fetched_at: 't2' }),
      row({ source_id: 'A', price_minor: '999', fetched_at: 't1' }),
    ], NOW_ROWS)
    expect(out).toHaveLength(1)
    expect(out[0]!.priceMinor).toBe('100')
  })

  it('drops a row whose payload is neither a recognisable flight nor hotel shape', () => {
    expect(newestResultItemPerSourceId([row({ payload: { kind: 'bogus' } })], NOW_ROWS)).toEqual([])
  })

  it('maps a pre-hotels-pass payload, defaulting every field it does not carry', () => {
    const out = newestResultItemPerSourceId([row({ source_id: 'H1', payload: hotelPayload })], NOW_ROWS)
    expect(out).toHaveLength(1)
    expect(out[0]!.hotel).toEqual({
      rating: 4, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26',
      propertyType: 'other', stars: null, reviews: null, images: [], amenities: [],
      essentials: [], nearby: [], pricePerNightMinor: null, distanceKm: null, coordinates: null,
    })
    expect(out[0]!.flight).toBeUndefined()
  })

  it('maps the hotels pass\'s own fields, and host-checks the photos a SECOND time', () => {
    const out = newestResultItemPerSourceId([row({ source_id: 'H2', payload: richHotelPayload })], NOW_ROWS)
    const hotel = out[0]!.hotel!
    expect(hotel.propertyType).toBe('hotel')
    expect(hotel.stars).toBe(3)
    expect(hotel.reviews).toBe(350)
    expect(hotel.pricePerNightMinor).toBe('7000')
    expect(hotel.distanceKm).toBe(3.2)
    expect(hotel.amenities).toEqual(['Free Wi-Fi', 'Parking'])
    expect(hotel.essentials).toEqual(['Entire apartment'])
    // The corpus outlives the code that filled it, so the allowlist runs again on the way out:
    // only the Google-hosted https URL may reach an `<img src>`.
    expect(hotel.images).toEqual(['https://lh3.googleusercontent.com/ok.png'])
    // A nearby entry with no name is dropped rather than rendered blank.
    expect(hotel.nearby).toEqual([{ name: 'Haneda Airport', minutes: 28, by: 'Taxi' }])
  })

  it('keeps a supplier NAME readable on its way to the browser, markup stripped', () => {
    const japanese = '\u30b7\u30c6\u30a3\u30d1\u30fc\u30eb\u685c\u65b0\u753a'
    const out = newestResultItemPerSourceId([
      row({ source_id: 'H4', name: japanese, payload: richHotelPayload }),
      row({ source_id: 'H5', name: '<script>alert(1)</script>', payload: richHotelPayload }),
    ], NOW_ROWS)
    // A card she cannot read is a card she cannot book from — see `maskDisplayName`.
    expect(out[0]!.name).toBe(japanese)
    // Markup is removed outright rather than left as printable ASCII.
    expect(out[1]!.name).toBe('scriptalert(1)/script')
  })

  it('refuses a per-night price that is not a plain decimal string', () => {
    const out = newestResultItemPerSourceId([
      row({ source_id: 'H3', payload: { ...richHotelPayload, pricePerNightMinor: '7000; drop table' } }),
    ], NOW_ROWS)
    expect(out[0]!.hotel!.pricePerNightMinor).toBeNull()
  })

  it('returns an empty list for no rows', () => {
    expect(newestResultItemPerSourceId([], NOW_ROWS)).toEqual([])
  })

  // Pass 3's bug: this used to be the caller's cue to DROP the item, which left the pane
  // rendering an empty list under a full summary bar fifteen minutes after any search.
  it('keeps a row past its own ttl and flags it expired', () => {
    const out = newestResultItemPerSourceId([row()], new Date('2026-10-01T10:20:00.000Z'))
    expect(out).toHaveLength(1)
    expect(out[0]!.expired).toBe(true)
    expect(newestResultItemPerSourceId([row()], NOW_ROWS)[0]!.expired).toBe(false)
  })
})

// Pass 3, section 1: expired items are FLAGGED, not dropped — see `ResultItemLite.expired`.
describe('isExpired', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z')

  it('is false inside the ttl', () => {
    expect(isExpired('2026-09-13T11:50:00.000Z', 900, NOW)).toBe(false)
  })

  it('is false exactly at the boundary, same rule as dropExpiredAlternatives', () => {
    expect(isExpired('2026-09-13T11:45:00.000Z', 900, NOW)).toBe(false)
  })

  it('is true past the ttl', () => {
    expect(isExpired('2026-09-13T11:40:00.000Z', 300, NOW)).toBe(true)
  })
})

describe('freshnessOf', () => {
  const item = (overrides: Partial<ResultItemLite> = {}): ResultItemLite => ({
    sourceId: 'A', name: 'n', priceMinor: '1', currency: 'EUR',
    fetchedAt: '2026-09-13T11:50:00.000Z', ttlSeconds: 900, expired: false,
    ...overrides,
  })

  it('reports the NEWEST item\'s fetchedAt', () => {
    expect(freshnessOf([
      item({ sourceId: 'A', fetchedAt: '2026-09-13T11:50:00.000Z' }),
      item({ sourceId: 'B', fetchedAt: '2026-09-13T11:58:00.000Z' }),
    ]).fetchedAt).toBe('2026-09-13T11:58:00.000Z')
  })

  it('is stale as soon as ANY item is expired', () => {
    expect(freshnessOf([item(), item({ sourceId: 'B', expired: true })]).stale).toBe(true)
    expect(freshnessOf([item(), item({ sourceId: 'B' })]).stale).toBe(false)
  })

  it('has no fetchedAt and is not stale for a row that resolved to nothing', () => {
    expect(freshnessOf([])).toEqual({ fetchedAt: null, stale: false })
  })
})

// Pass 3, section 1f.
describe('describeResultsForUi', () => {
  const base = {
    kind: 'flights' as const,
    query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
    assumptions: [],
  }

  it('says how many were shown for an ordinary row', () => {
    expect(describeResultsForUi({ ...base, sourceIds: ['a', 'b'] })).toBe('2 flights shown')
    expect(describeResultsForUi({ ...base, sourceIds: ['a'] })).toBe('1 flight shown')
    expect(describeResultsForUi({ ...base, kind: 'hotels', sourceIds: ['a', 'b'] })).toBe('2 hotels shown')
  })

  it('says the prices were refreshed for a refresh row', () => {
    expect(describeResultsForUi({ ...base, sourceIds: new Array(10).fill('a'), refreshed: true }))
      .toBe('Prices refreshed · 10 flights')
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

// Results UI pass 2, E. `skeletonMode` decides whether the results pane promises a shape before
// there is anything to put in it — and, for 'full', whether the split renders at all.
describe('skeletonMode', () => {
  it('is null whenever nothing is running, however little there is to show', () => {
    expect(skeletonMode({ status: 'active', resultKinds: [], latestAction: null })).toBeNull()
    expect(skeletonMode({ status: 'awaiting_user', resultKinds: [], latestAction: null })).toBeNull()
    expect(skeletonMode({ status: 'failed', resultKinds: ['flights'], latestAction: null })).toBeNull()
  })

  it('is "full" while the first search runs and there is nothing yet', () => {
    expect(skeletonMode({ status: 'working', resultKinds: [], latestAction: null })).toBe('full')
  })

  it('is "hotels" after a flight was chosen and the hotel search is running', () => {
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights'], latestAction: { action: 'choose', kind: 'flight' },
    })).toBe('hotels')
  })

  it('promises nothing for a turn with no list to promise — a question, or a typed filter', () => {
    // Both answer in the thread, so a placeholder beside the flights she already has would be
    // claiming a search that is not happening.
    expect(skeletonMode({ status: 'working', resultKinds: ['flights'], latestAction: null })).toBeNull()
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights'], latestAction: { action: 'hand_off', kind: null },
    })).toBeNull()
  })

  it('promises nothing once the hotels row has landed, even on the same choose action', () => {
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights', 'hotels'], latestAction: { action: 'choose', kind: 'flight' },
    })).toBeNull()
  })

  it('does not mistake a chosen HOTEL for a hotel search', () => {
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights'], latestAction: { action: 'choose', kind: 'hotel' },
    })).toBeNull()
  })

  // Pass 3, section 1e: a refresh IS a search, so it gets the same two shapes.
  it('is "full" while a flights refresh runs, and "hotels" while a hotels one does', () => {
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights'], latestAction: { action: 'refresh', kind: 'flight' },
    })).toBe('full')
    expect(skeletonMode({
      status: 'working', resultKinds: ['flights', 'hotels'], latestAction: { action: 'refresh', kind: 'hotel' },
    })).toBe('hotels')
  })
})
