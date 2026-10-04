// Plan 5, Task 9. `applyFilterLite`/`priceSteps`/`priceRange` are pure, so
// they are tested directly here, no DB and no rendering required.
import { describe, expect, it } from 'vitest'
import { applyFilterLite, priceSteps, priceRange } from '../web/filters.js'
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

describe('priceSteps', () => {
  it('returns five ascending steps up to and including max', () => {
    const steps = priceSteps(0n, 10_000n)
    expect(steps).toHaveLength(5)
    expect(steps[steps.length - 1]).toBe('10000')
    expect(steps.map(Number)).toEqual([2000, 4000, 6000, 8000, 10000])
  })

  it('returns a single step when min === max (and it is positive)', () => {
    expect(priceSteps(5000n, 5000n)).toEqual(['5000'])
  })

  it('returns no steps when max is zero', () => {
    expect(priceSteps(0n, 0n)).toEqual([])
  })

  it('never returns a step above max or below min', () => {
    const steps = priceSteps(1234n, 9876n).map(BigInt)
    for (const s of steps) {
      expect(s).toBeGreaterThanOrEqual(1234n)
      expect(s).toBeLessThanOrEqual(9876n)
    }
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
