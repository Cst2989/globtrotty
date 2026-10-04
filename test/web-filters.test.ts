// Plan 5, Task 9. `applyFilterLite`/`priceRange` and (results UI pass 2, D) the sort and rail
// helpers are pure, so they are tested directly here, no DB and no rendering required.
import { describe, expect, it } from 'vitest'
import {
  applyFilterLite, priceRange, sortItemsLite, leadersBySort, airlineCounts, airlineNamesOf,
  isFilterSet,
} from '../web/filters.js'
import type { ResultItemLite } from '../web/data.js'
import { hotelLite } from './helpers/web-lite.js'
// Task 10: reconciling this module's departure windows with
// `src/intake/filter.ts`'s own ones (see both files' `inWindow`).
import { applyFilter } from '../src/intake/filter.js'
import { filterKind } from '../src/results.js'
import { money } from '../src/money.js'
import { hotelDetail, type StoredItem } from '../src/supplier/types.js'
import type { Filter } from '../src/results.js'

type FlightOverrides = {
  sourceId?: string; name?: string; priceMinor?: string; currency?: string; fetchedAt?: string; ttlSeconds?: number
  flight?: Partial<NonNullable<ResultItemLite['flight']>>
}

function flight(overrides: FlightOverrides = {}): ResultItemLite {
  const { flight: flightOverrides, ...rest } = overrides
  return {
    sourceId: 'F1', name: 'Qatar Airways', priceMinor: '45600', currency: 'EUR',
    fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900, expired: false,
    flight: {
      outbound: { from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00', via: ['DOH'], viaCities: ['Doha'], viaCountries: ['QA'], viaCountryNames: ['Qatar'], carriers: ['QR'], carrierNames: ['Qatar Airways'], durationMinutes: 600 },
      inbound: null,
      stops: 1,
      inboundStops: null,
      durationMinutes: 855,
      airlines: ['QR'], airlineNames: ['Qatar Airways'],
      bags: { personal: 1, cabin: 1, checked: 1 },
      selfTransfer: false,
      ...flightOverrides,
    },
    ...rest,
  }
}

function hotel(overrides: Partial<ResultItemLite> = {}): ResultItemLite {
  return {
    sourceId: 'H1', name: 'Casa Bela', priceMinor: '45600', currency: 'EUR',
    fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900, expired: false,
    hotel: hotelLite({ rating: 4 }),
    ...overrides,
  }
}

describe('applyFilterLite', () => {
  it('passes everything through for an empty filter', () => {
    const items = [flight(), flight({ sourceId: 'F2' })]
    expect(applyFilterLite(items, {})).toEqual(items)
  })

  it('nonstop keeps only flight items with zero stops, and leaves a hotel item untouched', () => {
    const nonstop = flight({ sourceId: 'F1', flight: { stops: 0 } })
    const oneStop = flight({ sourceId: 'F2', flight: { stops: 1 } })
    const stay = hotel()
    const out = applyFilterLite([nonstop, oneStop, stay], { nonstop: true })
    expect(out.map((i) => i.sourceId)).toEqual(['F1', 'H1'])
  })

  it('maxStops excludes anything with more stops than allowed', () => {
    const items = [
      flight({ sourceId: 'F0', flight: { stops: 0 } }),
      flight({ sourceId: 'F1', flight: { stops: 1 } }),
      flight({ sourceId: 'F2', flight: { stops: 2 } }),
    ]
    expect(applyFilterLite(items, { maxStops: 1 }).map((i) => i.sourceId)).toEqual(['F0', 'F1'])
  })

  it('departure window matches the outbound leg\'s local hour, read without parsing a Date', () => {
    const morning = flight({ sourceId: 'FA', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-19T09:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
    const evening = flight({ sourceId: 'FB', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T21:00:00', arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
    expect(applyFilterLite([morning, evening], { departure: 'morning' }).map((i) => i.sourceId)).toEqual(['FA'])
    expect(applyFilterLite([morning, evening], { departure: 'evening' }).map((i) => i.sourceId)).toEqual(['FB'])
  })

  it('maxPriceMinor applies to both flight and hotel items, by their own total price', () => {
    const cheapFlight = flight({ sourceId: 'F1', priceMinor: '10000' })
    const pricyFlight = flight({ sourceId: 'F2', priceMinor: '99999' })
    const cheapHotel = hotel({ sourceId: 'H1', priceMinor: '20000' })
    const out = applyFilterLite([cheapFlight, pricyFlight, cheapHotel], { maxPriceMinor: '50000' })
    expect(out.map((i) => i.sourceId)).toEqual(['F1', 'H1'])
  })

  it('airlines keeps a flight item only if one of its airlines is in the filter list', () => {
    const qr = flight({ sourceId: 'F1', flight: { airlines: ['QR'] } })
    const lh = flight({ sourceId: 'F2', flight: { airlines: ['LH'] } })
    expect(applyFilterLite([qr, lh], { airlines: ['QR'] }).map((i) => i.sourceId)).toEqual(['F1'])
  })

  it('combining filters reduces the list further than either alone (render-reduction check)', () => {
    const items = [
      flight({ sourceId: 'F0', flight: { stops: 0 }, priceMinor: '10000' }),
      flight({ sourceId: 'F1', flight: { stops: 1 }, priceMinor: '10000' }),
      flight({ sourceId: 'F2', flight: { stops: 0 }, priceMinor: '99999' }),
    ]
    const nonstopOnly = applyFilterLite(items, { nonstop: true })
    const nonstopAndCheap = applyFilterLite(items, { nonstop: true, maxPriceMinor: '50000' })
    expect(nonstopOnly.length).toBeGreaterThan(nonstopAndCheap.length)
    expect(nonstopAndCheap.map((i) => i.sourceId)).toEqual(['F0'])
  })
})


describe('priceRange', () => {
  it('finds the min and max priceMinor across items', () => {
    const items = [flight({ priceMinor: '500' }), flight({ priceMinor: '100' }), flight({ priceMinor: '900' })]
    expect(priceRange(items)).toEqual({ min: 100n, max: 900n })
  })

  it('returns zero/zero for an empty list', () => {
    expect(priceRange([])).toEqual({ min: 0n, max: 0n })
  })
})

/** A minimal one-way flight `StoredItem` at a given outbound hour — same pattern as test/intake-filter.test.ts's own `flight` helper. */
function storedFlight(sourceId: string, outboundHour: number): StoredItem {
  return {
    sourceId, supplier: 'mock', kind: 'flight', name: `flight ${sourceId}`,
    price: money(45_600n, 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null, searchParams: null,
    detail: {
      kind: 'flight',
      outbound: {
        from: 'BCN', to: 'TYO',
        departureLocal: `2026-11-19T${String(outboundHour).padStart(2, '0')}:00:00`,
        arrivalLocal: '2026-11-19T20:00:00',
        stops: 0, route: ['BCN', 'TYO'], cabinClass: 'Economy', carriers: ['ZZ'], flightNumbers: ['ZZ1'],
      },
      inbound: null,
      baggage: { personalItem: 1, cabinBag: 1, checkedBag: 1 },
      totalDurationSeconds: 12_600,
      selfTransfer: false,
    },
  }
}

/**
 * Task 10: `web/filters.ts`'s `inWindow` (used by `applyFilterLite`, the
 * chip path) and `src/intake/filter.ts`'s own `inWindow` (used by
 * `applyFilter`, the typed-filter path — src/agents/filter.ts, a different
 * task) started life with slightly different boundaries. This pins both
 * modules against the SAME three outbound hours — one clearly in each
 * window — so a chip and a typed filter can never silently disagree on
 * where morning ends and evening begins.
 */
describe('departure window reconciliation (web/filters.ts vs src/intake/filter.ts)', () => {
  const HOURS: Record<'morning' | 'afternoon' | 'evening', number> = { morning: 9, afternoon: 14, evening: 20 }

  it('both modules classify the morning (9), afternoon (14) and evening (20) hour the same way', () => {
    for (const [window, hour] of Object.entries(HOURS) as ['morning' | 'afternoon' | 'evening', number][]) {
      const lite = flight({ sourceId: 'X', flight: { outbound: { from: 'A', to: 'B', departureLocal: `2026-11-19T${String(hour).padStart(2, '0')}:00:00`, arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
      const stored = storedFlight('X', hour)

      const liteMatches = applyFilterLite([lite], { departure: window }).length === 1
      const storedMatches = applyFilter([stored], { departure: window }).length === 1
      expect(liteMatches).toBe(true)
      expect(storedMatches).toBe(true)
      expect(liteMatches).toBe(storedMatches)
    }
  })

  it('each hour matches exactly one of the three windows in both modules', () => {
    for (const hour of Object.values(HOURS)) {
      const lite = flight({ sourceId: 'X', flight: { outbound: { from: 'A', to: 'B', departureLocal: `2026-11-19T${String(hour).padStart(2, '0')}:00:00`, arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
      const stored = storedFlight('X', hour)
      const windows: Array<'morning' | 'afternoon' | 'evening'> = ['morning', 'afternoon', 'evening']

      const liteHits = windows.filter((w) => applyFilterLite([lite], { departure: w }).length === 1)
      const storedHits = windows.filter((w) => applyFilter([stored], { departure: w }).length === 1)
      expect(liteHits).toHaveLength(1)
      expect(storedHits).toHaveLength(1)
      expect(liteHits).toEqual(storedHits)
    }
  })
})

/**
 * Final review, I3 — the ledger's deferred item, now closed. `web/data.ts`'s `flightLite` set
 * `stops` from the OUTBOUND leg only and `web/filters.ts` judged `nonstop`/`maxStops` on that
 * single number, while `src/intake/filter.ts` requires EVERY leg: she clicked "Nonstop" and got
 * a flight whose return leg had two stops, then typed "only direct flights" and watched it go.
 * Same ids, two answers. This pins both modules against the same three items, the same shape as
 * the departure-window block above.
 */
describe('stops reconciliation (web/filters.ts vs src/intake/filter.ts)', () => {
  /** A return flight, outbound and inbound stops given separately. */
  function liteReturn(sourceId: string, out: number, back: number): ResultItemLite {
    return flight({
      sourceId,
      flight: {
        outbound: { from: 'BCN', to: 'TYO', departureLocal: '2026-11-19T09:00:00', arrivalLocal: '2026-11-20T10:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 },
        inbound: { from: 'TYO', to: 'BCN', departureLocal: '2026-12-06T09:00:00', arrivalLocal: '2026-12-06T20:00:00', via: [], viaCities: [], viaCountries: [], viaCountryNames: [], carriers: [], carrierNames: [], durationMinutes: 600 },
        stops: out,
        inboundStops: back,
      },
    })
  }

  function storedReturn(sourceId: string, out: number, back: number): StoredItem {
    const base = storedFlight(sourceId, 9)
    if (base.detail.kind !== 'flight') throw new Error('unreachable')
    return {
      ...base,
      detail: {
        ...base.detail,
        outbound: { ...base.detail.outbound, stops: out },
        inbound: {
          from: 'TYO', to: 'BCN', departureLocal: '2026-12-06T09:00:00', arrivalLocal: '2026-12-06T20:00:00',
          stops: back, route: ['TYO', 'BCN'], cabinClass: 'Economy', carriers: ['ZZ'], flightNumbers: ['ZZ2'],
        },
      },
    }
  }

  // A: direct both ways. B: direct out, two stops back — the exact item I3 names. C: one stop
  // each way.
  const CASES: Array<[string, number, number]> = [['A', 0, 0], ['B', 0, 2], ['C', 1, 1]]
  const lite = CASES.map(([id, out, back]) => liteReturn(id, out, back))
  const stored = CASES.map(([id, out, back]) => storedReturn(id, out, back))

  it('nonstop agrees on all three items — B is excluded by its RETURN leg', () => {
    const liteIds = applyFilterLite(lite, { nonstop: true }).map((i) => i.sourceId)
    const storedIds = applyFilter(stored, { nonstop: true }).map((i) => i.sourceId)
    expect(liteIds).toEqual(['A'])
    expect(liteIds).toEqual(storedIds)
  })

  it('maxStops agrees on all three items at every bound from 0 to 2', () => {
    for (const maxStops of [0, 1, 2]) {
      const liteIds = applyFilterLite(lite, { maxStops }).map((i) => i.sourceId)
      const storedIds = applyFilter(stored, { maxStops }).map((i) => i.sourceId)
      expect(liteIds, `maxStops ${maxStops}`).toEqual(storedIds)
    }
    expect(applyFilterLite(lite, { maxStops: 0 }).map((i) => i.sourceId)).toEqual(['A'])
    expect(applyFilterLite(lite, { maxStops: 1 }).map((i) => i.sourceId)).toEqual(['A', 'C'])
    expect(applyFilterLite(lite, { maxStops: 2 }).map((i) => i.sourceId)).toEqual(['A', 'B', 'C'])
  })

  it('a one-way is judged on its single leg in both modules', () => {
    const liteOneWay = flight({ sourceId: 'OW', flight: { inbound: null, stops: 0, inboundStops: null } })
    const storedOneWay = storedFlight('OW', 9)   // inbound null, outbound stops 0
    expect(applyFilterLite([liteOneWay], { nonstop: true })).toHaveLength(1)
    expect(applyFilter([storedOneWay], { nonstop: true })).toHaveLength(1)
  })
})

// Results UI pass 2, D. The bag minimums and the hotel rating are on `Filter` (src/results.ts)
// rather than in the pane's own state so a typed message can reach the same code later, which
// means `applyFilterLite` and `applyFilter` have to agree on them the way they already agree on
// stops and departure windows.
describe('bag and rating filters, in both modules', () => {
  const noBags = flight({ sourceId: 'F0', flight: { bags: { personal: 1, cabin: 0, checked: 0 } } })
  const cabinOnly = flight({ sourceId: 'F1', flight: { bags: { personal: 1, cabin: 1, checked: 0 } } })
  const both = flight({ sourceId: 'F2', flight: { bags: { personal: 1, cabin: 1, checked: 1 } } })
  const items = [noBags, cabinOnly, both]

  it('minCabinBags hides a fare with fewer cabin bags included', () => {
    expect(applyFilterLite(items, { minCabinBags: 1 }).map((i) => i.sourceId)).toEqual(['F1', 'F2'])
  })

  it('minCheckedBags hides a fare with no checked bag', () => {
    expect(applyFilterLite(items, { minCheckedBags: 1 }).map((i) => i.sourceId)).toEqual(['F2'])
  })

  it('a zero minimum is the filter being off, not a requirement of zero bags', () => {
    expect(applyFilterLite(items, { minCabinBags: 0 })).toHaveLength(3)
  })

  it('agrees with src/intake/filter.ts over the same bag allowances', () => {
    const stored = (sourceId: string, cabinBag: number, checkedBag: number): StoredItem => ({
      sourceId, supplier: 'mock', kind: 'flight', name: 'f', price: money(45_600n, 'EUR'),
      priceBasis: 'total', fetchedAt: new Date('2026-10-01T10:00:00.000Z'), ttlSeconds: 900,
      bookingUrl: null, searchParams: null,
      detail: {
        kind: 'flight',
        outbound: {
          from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00',
          stops: 1, route: ['BCN', 'DOH', 'HND'], cabinClass: 'economy', carriers: ['QR'], flightNumbers: ['QR1'],
        },
        inbound: null,
        baggage: { personalItem: 1, cabinBag, checkedBag },
        totalDurationSeconds: 51_300, selfTransfer: false,
      },
    })
    const storedItems = [stored('F0', 0, 0), stored('F1', 1, 0), stored('F2', 1, 1)]
    for (const filter of [{ minCabinBags: 1 }, { minCheckedBags: 1 }, { minCabinBags: 1, minCheckedBags: 1 }]) {
      expect(applyFilter(storedItems, filter).map((i) => i.sourceId))
        .toEqual(applyFilterLite(items, filter).map((i) => i.sourceId))
    }
  })

  it('minRating keeps a stay rated at or above it, and drops an unrated one', () => {
    const hotel = (sourceId: string, rating: number | null): ResultItemLite => ({
      sourceId, name: 'h', priceMinor: '100000', currency: 'EUR',
      fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900, expired: false,
      hotel: hotelLite({ rating }),
    })
    const hotels = [hotel('H3', 3), hotel('H4', 4), hotel('H0', null)]
    expect(applyFilterLite(hotels, { minRating: 3 }).map((i) => i.sourceId)).toEqual(['H3', 'H4'])
    expect(applyFilterLite(hotels, { minRating: 4 }).map((i) => i.sourceId)).toEqual(['H4'])
  })

  it('leaves a flight alone when minRating is set, and a stay alone when the bag minimums are', () => {
    expect(applyFilterLite(items, { minRating: 4 })).toHaveLength(3)
  })
})

describe('sortItemsLite', () => {
  const a = flight({ sourceId: 'A', priceMinor: '30000', flight: { durationMinutes: 900 } })
  const b = flight({ sourceId: 'B', priceMinor: '10000', flight: { durationMinutes: 1200 } })
  const c = flight({ sourceId: 'C', priceMinor: '20000', flight: { durationMinutes: 600 } })
  const items = [a, b, c]

  it('best keeps the stored order — Jev\'s own re-rank, which no sort here knows better than', () => {
    expect(sortItemsLite(items, 'best').map((i) => i.sourceId)).toEqual(['A', 'B', 'C'])
  })

  it('cheapest sorts by price ascending', () => {
    expect(sortItemsLite(items, 'cheapest').map((i) => i.sourceId)).toEqual(['B', 'C', 'A'])
  })

  it('fastest sorts by the whole itinerary duration ascending', () => {
    expect(sortItemsLite(items, 'fastest').map((i) => i.sourceId)).toEqual(['C', 'A', 'B'])
  })

  it('never mutates its argument', () => {
    sortItemsLite(items, 'cheapest')
    expect(items.map((i) => i.sourceId)).toEqual(['A', 'B', 'C'])
  })

  it('keeps the stored order for a tie, so a tiebreak is never arbitrary', () => {
    const tie = [flight({ sourceId: 'X', priceMinor: '10000' }), flight({ sourceId: 'Y', priceMinor: '10000' })]
    expect(sortItemsLite(tie, 'cheapest').map((i) => i.sourceId)).toEqual(['X', 'Y'])
  })

  it('compares prices as bigints, never as numbers in a string', () => {
    const big = [flight({ sourceId: 'BIG', priceMinor: '900000' }), flight({ sourceId: 'SMALL', priceMinor: '1000000' })]
    expect(sortItemsLite(big, 'cheapest').map((i) => i.sourceId)).toEqual(['BIG', 'SMALL'])
  })
})

describe('leadersBySort', () => {
  it('names the item each sort would put first', () => {
    const items = [
      flight({ sourceId: 'A', priceMinor: '30000', flight: { durationMinutes: 900 } }),
      flight({ sourceId: 'B', priceMinor: '10000', flight: { durationMinutes: 1200 } }),
    ]
    const leaders = leadersBySort(items, ['best', 'cheapest', 'fastest'])
    expect(leaders.get('best')!.sourceId).toBe('A')
    expect(leaders.get('cheapest')!.sourceId).toBe('B')
    expect(leaders.get('fastest')!.sourceId).toBe('A')
  })

  it('is null per sort for an empty list', () => {
    expect(leadersBySort([], ['best', 'cheapest']).get('best')).toBeNull()
  })
})

describe('airlineCounts / airlineNamesOf', () => {
  const items = [
    flight({ sourceId: 'A', flight: { airlines: ['QR'], airlineNames: ['Qatar Airways'] } }),
    flight({ sourceId: 'B', flight: { airlines: ['QR', 'LH'], airlineNames: ['Qatar Airways', 'Lufthansa'] } }),
  ]

  it('counts how many results each carrier appears on', () => {
    expect([...airlineCounts(items).entries()].sort()).toEqual([['LH', 1], ['QR', 2]])
  })

  it('pairs each code with the name web/data.ts resolved for it', () => {
    expect(airlineNamesOf(items).get('LH')).toBe('Lufthansa')
  })
})

describe('isFilterSet', () => {
  it('is false for an empty filter and for one whose only array is empty', () => {
    expect(isFilterSet({})).toBe(false)
    expect(isFilterSet({ airlines: [] })).toBe(false)
  })

  it('is true as soon as anything narrows the list', () => {
    expect(isFilterSet({ nonstop: true })).toBe(true)
    expect(isFilterSet({ minCheckedBags: 1 })).toBe(true)
    expect(isFilterSet({ airlines: ['QR'] })).toBe(true)
  })
})

/**
 * Hotels pass, section 4. The five hotel filters, pinned against BOTH implementations over the
 * same stay — `applyFilterLite` (web/filters.ts, over the lite shape) and `applyFilter`
 * (src/intake/filter.ts, over the corpus). The two have to answer identically or a chip and a
 * typed filter disagree about the same list, which is the fault the ledger's I3 was made of.
 */
describe('hotel filter reconciliation (web/filters.ts vs src/intake/filter.ts)', () => {
  type StayFields = {
    rating?: number | null
    stars?: number | null
    propertyType?: 'hotel' | 'rental' | 'other'
    amenities?: string[]
    distanceKm?: number | null
  }

  function pair(sourceId: string, over: StayFields = {}) {
    const fields = {
      rating: 4.4, stars: 4, propertyType: 'hotel' as const,
      amenities: ['Free Wi-Fi', 'Outdoor pool'], distanceKm: 1.2,
      ...over,
    }
    const lite: ResultItemLite = {
      sourceId, name: 'stay', priceMinor: '100000', currency: 'EUR',
      fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 3600, expired: false,
      hotel: hotelLite(fields),
    }
    const stored: StoredItem = {
      sourceId, supplier: 'searchapi', kind: 'hotel', name: 'stay',
      price: money(100_000n, 'EUR'), priceBasis: 'total',
      fetchedAt: new Date('2026-10-01T10:00:00.000Z'), ttlSeconds: 3600, bookingUrl: null,
      searchParams: null,
      detail: hotelDetail({ checkIn: '2026-11-19', checkOut: '2026-11-26', nights: 7, ...fields }),
    }
    return { lite, stored }
  }

  /** Both modules, same stay, same filter — and they must agree. */
  function bothKeep(stay: ReturnType<typeof pair>, filter: Filter): boolean {
    const liteKept = applyFilterLite([stay.lite], filter).length === 1
    const storedKept = applyFilter([stay.stored], filter).length === 1
    expect(liteKept).toBe(storedKept)
    return liteKept
  }

  it('stars: keeps a listed class, drops the others, and drops an unclassified stay', () => {
    expect(bothKeep(pair('A', { stars: 4 }), { stars: [3, 4] })).toBe(true)
    expect(bothKeep(pair('B', { stars: 5 }), { stars: [3, 4] })).toBe(false)
    expect(bothKeep(pair('C', { stars: null }), { stars: [3, 4] })).toBe(false)
    // An empty list narrows nothing, in both.
    expect(bothKeep(pair('D', { stars: null }), { stars: [] })).toBe(true)
  })

  it('propertyType: hotels only, rentals only, and neither for a property of unknown type', () => {
    expect(bothKeep(pair('A', { propertyType: 'hotel' }), { propertyType: 'hotel' })).toBe(true)
    expect(bothKeep(pair('B', { propertyType: 'rental' }), { propertyType: 'hotel' })).toBe(false)
    expect(bothKeep(pair('C', { propertyType: 'rental' }), { propertyType: 'rental' })).toBe(true)
    expect(bothKeep(pair('D', { propertyType: 'other' }), { propertyType: 'hotel' })).toBe(false)
  })

  it('amenities: matches the supplier\'s own spellings, and requires ALL of them', () => {
    // "Free Wi-Fi" and "Outdoor pool" are real labels from the recorded Tokyo response.
    expect(bothKeep(pair('A'), { amenities: ['wifi'] })).toBe(true)
    expect(bothKeep(pair('A'), { amenities: ['wifi', 'pool'] })).toBe(true)
    expect(bothKeep(pair('A'), { amenities: ['wifi', 'kitchen'] })).toBe(false)
    expect(bothKeep(pair('B', { amenities: ['Parking ($)'] }), { amenities: ['parking'] })).toBe(true)
    expect(bothKeep(pair('C', { amenities: [] }), { amenities: ['wifi'] })).toBe(false)
  })

  it('nearCentre: 3 km in, 3.1 km out, and a stay with no distance out', () => {
    expect(bothKeep(pair('A', { distanceKm: 3 }), { nearCentre: true })).toBe(true)
    expect(bothKeep(pair('B', { distanceKm: 3.1 }), { nearCentre: true })).toBe(false)
    expect(bothKeep(pair('C', { distanceKm: null }), { nearCentre: true })).toBe(false)
  })

  it('minRating: the bar\'s own two bands, and an unrated stay out of both', () => {
    expect(bothKeep(pair('A', { rating: 4.4 }), { minRating: 4 })).toBe(true)
    expect(bothKeep(pair('B', { rating: 4.4 }), { minRating: 4.5 })).toBe(false)
    expect(bothKeep(pair('C', { rating: null }), { minRating: 4 })).toBe(false)
  })

  it('a flight passes every hotel-only filter untouched, in both', () => {
    const liteFlight = flight({ sourceId: 'F1' })
    const storedF = storedFlight('F1', 9)
    for (const filter of [
      { stars: [5] }, { propertyType: 'hotel' as const }, { amenities: ['wifi'] }, { nearCentre: true },
    ]) {
      expect(applyFilterLite([liteFlight], filter)).toHaveLength(1)
      expect(applyFilter([storedF], filter)).toHaveLength(1)
    }
  })
})

/**
 * The bug this filter exists for: "I don't want to stop in China or the Middle East" used to
 * classify as `filter` and change nothing, because no dimension matched a connection's own
 * country. Three BCN→TYO items, one direct and two connecting (one via Doha — Qatar, middle
 * east; one via Shanghai Pudong — China), pinned against BOTH modules the same way every other
 * dimension in this file is.
 */
describe('connections filter (avoidCountries/avoidRegions), reconciled with src/intake/filter.ts', () => {
  /** A BCN→TYO lite item with a single via stop (or none, for `viaCode: null`). */
  function liteVia(sourceId: string, viaCode: string | null, viaCity: string, viaCountry: string | null, viaCountryName: string | null): ResultItemLite {
    return flight({
      sourceId,
      flight: {
        outbound: {
          from: 'BCN', to: 'TYO', departureLocal: '2026-11-19T09:00:00', arrivalLocal: '2026-11-20T10:00:00',
          via: viaCode === null ? [] : [viaCode],
          viaCities: viaCode === null ? [] : [viaCity],
          viaCountries: viaCode === null ? [] : [viaCountry],
          viaCountryNames: viaCode === null ? [] : [viaCountryName],
          carriers: ['QR'], carrierNames: ['Qatar Airways'], durationMinutes: 600,
        },
      },
    })
  }

  /** The same itinerary as a corpus `StoredItem`, via `src/intake/filter.ts`'s own lookup
   * (`airportCountry`/`regionOfCountry`) rather than a pre-resolved field. */
  function storedVia(sourceId: string, viaCode: string | null): StoredItem {
    const base = storedFlight(sourceId, 9)
    if (base.detail.kind !== 'flight') throw new Error('unreachable')
    const route = viaCode === null ? ['BCN', 'TYO'] : ['BCN', viaCode, 'TYO']
    return { ...base, detail: { ...base.detail, outbound: { ...base.detail.outbound, route } } }
  }

  const doh = { lite: liteVia('DOH1', 'DOH', 'Doha', 'QA', 'Qatar'), stored: storedVia('DOH1', 'DOH') }
  const pvg = { lite: liteVia('PVG1', 'PVG', 'Shanghai', 'CN', 'China'), stored: storedVia('PVG1', 'PVG') }
  const direct = { lite: liteVia('DIRECT', null, '', null, null), stored: storedVia('DIRECT', null) }

  it('avoidRegions: middle_east excludes the Doha connection, keeps Shanghai and the direct one', () => {
    const filter: Filter = { avoidRegions: ['middle_east'] }
    expect(applyFilterLite([doh.lite, pvg.lite, direct.lite], filter).map((i) => i.sourceId))
      .toEqual(['PVG1', 'DIRECT'])
    expect(applyFilter([doh.stored, pvg.stored, direct.stored], filter).map((i) => i.sourceId))
      .toEqual(['PVG1', 'DIRECT'])
  })

  it('avoidRegions: china excludes the Shanghai connection, keeps Doha', () => {
    const filter: Filter = { avoidRegions: ['china'] }
    expect(applyFilterLite([doh.lite, pvg.lite], filter).map((i) => i.sourceId)).toEqual(['DOH1'])
    expect(applyFilter([doh.stored, pvg.stored], filter).map((i) => i.sourceId)).toEqual(['DOH1'])
  })

  it('both regions at once exclude both connections, keeping only the direct item', () => {
    const filter: Filter = { avoidRegions: ['china', 'middle_east'] }
    expect(applyFilterLite([doh.lite, pvg.lite, direct.lite], filter).map((i) => i.sourceId)).toEqual(['DIRECT'])
    expect(applyFilter([doh.stored, pvg.stored, direct.stored], filter).map((i) => i.sourceId)).toEqual(['DIRECT'])
  })

  it('avoidCountries excludes by the exact country, independent of the region list', () => {
    const filter: Filter = { avoidCountries: ['QA'] }
    expect(applyFilterLite([doh.lite, pvg.lite], filter).map((i) => i.sourceId)).toEqual(['PVG1'])
    expect(applyFilter([doh.stored, pvg.stored], filter).map((i) => i.sourceId)).toEqual(['PVG1'])
  })

  it('an airport neither table places by country is never excluded, in either module', () => {
    const unknown = { lite: liteVia('ZZ1', 'ZZZ', 'ZZZ', null, null), stored: storedVia('ZZ1', 'ZZZ') }
    const filter: Filter = { avoidRegions: ['china', 'middle_east', 'russia', 'usa', 'europe', 'asia', 'africa', 'south_america', 'north_america', 'oceania'] }
    expect(applyFilterLite([unknown.lite], filter)).toHaveLength(1)
    expect(applyFilter([unknown.stored], filter)).toHaveLength(1)
  })

  it('a hotel passes the connections filter untouched, in both', () => {
    const liteHotel = hotel({ sourceId: 'H1' })
    const storedHotel: StoredItem = {
      sourceId: 'H1', supplier: 'mock', kind: 'hotel', name: 'hotel H1',
      price: money(45_600n, 'EUR'), priceBasis: 'total',
      fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null, searchParams: null,
      detail: hotelDetail({ checkIn: '2026-11-19', checkOut: '2026-12-06', nights: 17, rating: 4 }),
    }
    const filter: Filter = { avoidRegions: ['china'] }
    expect(applyFilterLite([liteHotel], filter)).toHaveLength(1)
    expect(applyFilter([storedHotel], filter)).toHaveLength(1)
  })
})

describe('sortItemsLite: Top rated', () => {
  const stay = (sourceId: string, rating: number | null): ResultItemLite => ({
    sourceId, name: 'stay', priceMinor: '100000', currency: 'EUR',
    fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 3600, expired: false,
    hotel: hotelLite({ rating }),
  })

  it('orders by rating descending, with an unrated stay last rather than as a zero', () => {
    const items = [stay('A', 3.9), stay('B', null), stay('C', 4.6)]
    expect(sortItemsLite(items, 'rated').map((i) => i.sourceId)).toEqual(['C', 'A', 'B'])
    // Never mutates its argument, same contract as the other sorts.
    expect(items.map((i) => i.sourceId)).toEqual(['A', 'B', 'C'])
  })
})

/**
 * Trip-stage pass, found by the browser harness: a typed "only direct flights" at the hotels
 * stage narrowed the HOTELS row, and the desk answered "Showing 19 of 19: nonstop" about a list
 * of Tokyo hotels. A filter names its own kind; nothing about where she happens to be looking
 * changes it. `routeTyped` (src/agents/router.ts) reads this to pick the row it applies to.
 */
describe('filterKind', () => {
  it('reads a flight filter off any of its flight-only fields', () => {
    expect(filterKind({ nonstop: true })).toBe('flights')
    expect(filterKind({ maxStops: 1 })).toBe('flights')
    expect(filterKind({ departure: 'evening' })).toBe('flights')
    expect(filterKind({ airlines: ['QR'] })).toBe('flights')
    expect(filterKind({ minCabinBags: 1 })).toBe('flights')
    expect(filterKind({ minCheckedBags: 1 })).toBe('flights')
  })

  it('reads a stay filter off any of its hotel-only fields', () => {
    expect(filterKind({ minRating: 4 })).toBe('hotels')
    expect(filterKind({ stars: [4, 5] })).toBe('hotels')
    expect(filterKind({ propertyType: 'rental' })).toBe('hotels')
    expect(filterKind({ amenities: ['wifi'] })).toBe('hotels')
    expect(filterKind({ nearCentre: true })).toBe('hotels')
  })

  it('names no kind for a filter that could be about either list, or about neither', () => {
    // A price cap is the one field both lists share.
    expect(filterKind({ maxPriceMinor: '50000' })).toBeNull()
    expect(filterKind({})).toBeNull()
    // Both vocabularies at once is a guess about a screen that does not exist; the row she is
    // looking at decides it.
    expect(filterKind({ nonstop: true, minRating: 4 })).toBeNull()
  })
})
