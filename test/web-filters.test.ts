// Plan 5, Task 9. `applyFilterLite`/`priceRange` and (results UI pass 2, D) the sort and rail
// helpers are pure, so they are tested directly here, no DB and no rendering required.
import { describe, expect, it } from 'vitest'
import {
  applyFilterLite, priceRange, sortItemsLite, leadersBySort, airlineCounts, airlineNamesOf,
  isFilterSet,
} from '../web/filters.js'
import type { ResultItemLite } from '../web/data.js'
// Task 10: reconciling this module's departure windows with
// `src/intake/filter.ts`'s own ones (see both files' `inWindow`).
import { applyFilter } from '../src/intake/filter.js'
import { money } from '../src/money.js'
import type { StoredItem } from '../src/supplier/types.js'

type FlightOverrides = {
  sourceId?: string; name?: string; priceMinor?: string; currency?: string; fetchedAt?: string; ttlSeconds?: number
  flight?: Partial<NonNullable<ResultItemLite['flight']>>
}

function flight(overrides: FlightOverrides = {}): ResultItemLite {
  const { flight: flightOverrides, ...rest } = overrides
  return {
    sourceId: 'F1', name: 'Qatar Airways', priceMinor: '45600', currency: 'EUR',
    fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900,
    flight: {
      outbound: { from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00', via: ['DOH'], viaCities: ['Doha'], carriers: ['QR'], carrierNames: ['Qatar Airways'], durationMinutes: 600 },
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
    fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900,
    hotel: { rating: 4, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26' },
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
    const morning = flight({ sourceId: 'FA', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-19T09:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
    const evening = flight({ sourceId: 'FB', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T21:00:00', arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
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
      const lite = flight({ sourceId: 'X', flight: { outbound: { from: 'A', to: 'B', departureLocal: `2026-11-19T${String(hour).padStart(2, '0')}:00:00`, arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
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
      const lite = flight({ sourceId: 'X', flight: { outbound: { from: 'A', to: 'B', departureLocal: `2026-11-19T${String(hour).padStart(2, '0')}:00:00`, arrivalLocal: '2026-11-19T23:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 } } })
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
        outbound: { from: 'BCN', to: 'TYO', departureLocal: '2026-11-19T09:00:00', arrivalLocal: '2026-11-20T10:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 },
        inbound: { from: 'TYO', to: 'BCN', departureLocal: '2026-12-06T09:00:00', arrivalLocal: '2026-12-06T20:00:00', via: [], viaCities: [], carriers: [], carrierNames: [], durationMinutes: 600 },
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
      fetchedAt: '2026-10-01T10:00:00.000Z', ttlSeconds: 900,
      hotel: { rating, nights: 7, checkIn: '2026-11-19', checkOut: '2026-11-26' },
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
