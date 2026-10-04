import { describe, expect, it } from 'vitest'
import { applyFilter, describeFilter } from '../src/intake/filter.js'
import { money } from '../src/money.js'
import { hotelDetail } from '../src/supplier/types.js'
import type { StoredItem } from '../src/supplier/types.js'

/** A hand-built flight `StoredItem`, same pattern as test/intake-rank.test.ts's `buildItem`. */
function flight(
  sourceId: string, priceMinor: number,
  opts: {
    outboundStops?: number; inboundStops?: number; outboundHour?: number; carriers?: string[]
    oneWay?: boolean; cabinBag?: number; checkedBag?: number
  } = {},
): StoredItem {
  return {
    sourceId, supplier: 'mock', kind: 'flight', name: `flight ${sourceId}`,
    price: money(BigInt(priceMinor), 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null, searchParams: null,
    detail: {
      kind: 'flight',
      outbound: {
        from: 'BCN', to: 'TYO',
        departureLocal: `2026-11-19T${String(opts.outboundHour ?? 8).padStart(2, '0')}:00:00`,
        arrivalLocal: '2026-11-19T20:00:00',
        stops: opts.outboundStops ?? 0, route: ['BCN', 'TYO'], cabinClass: 'Economy',
        carriers: opts.carriers ?? ['ZZ'], flightNumbers: ['ZZ1'],
      },
      inbound: opts.oneWay ? null : {
        from: 'TYO', to: 'BCN', departureLocal: '2026-12-06T18:00:00', arrivalLocal: '2026-12-07T06:00:00',
        stops: opts.inboundStops ?? 0, route: ['TYO', 'BCN'], cabinClass: 'Economy',
        carriers: opts.carriers ?? ['ZZ'], flightNumbers: ['ZZ2'],
      },
      baggage: { personalItem: 1, cabinBag: opts.cabinBag ?? 1, checkedBag: opts.checkedBag ?? 1 },
      totalDurationSeconds: 12_600,
      selfTransfer: false,
    },
  }
}

function hotel(sourceId: string, priceMinor: number): StoredItem {
  return {
    sourceId, supplier: 'mock', kind: 'hotel', name: `hotel ${sourceId}`,
    price: money(BigInt(priceMinor), 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null, searchParams: null,
    detail: hotelDetail({ checkIn: '2026-11-19', checkOut: '2026-12-06', nights: 17, rating: 4 }),
  }
}

describe('applyFilter', () => {
  it('nonstop keeps only items whose outbound AND inbound legs are both stops === 0', () => {
    const items = [
      flight('a', 1000, { outboundStops: 0, inboundStops: 0 }),
      flight('b', 1000, { outboundStops: 1, inboundStops: 0 }),
      flight('c', 1000, { outboundStops: 0, inboundStops: 1 }),
    ]
    expect(applyFilter(items, { nonstop: true }).map((i) => i.sourceId)).toEqual(['a'])
  })

  it('departure windows apply to the OUTBOUND leg only — morning < 12:00, afternoon 12:00-17:59, evening >= 18:00', () => {
    const items = [
      flight('morning', 1000, { outboundHour: 9 }),
      flight('noon', 1000, { outboundHour: 12 }),
      flight('evening', 1000, { outboundHour: 18 }),
    ]
    expect(applyFilter(items, { departure: 'morning' }).map((i) => i.sourceId)).toEqual(['morning'])
    expect(applyFilter(items, { departure: 'afternoon' }).map((i) => i.sourceId)).toEqual(['noon'])
    expect(applyFilter(items, { departure: 'evening' }).map((i) => i.sourceId)).toEqual(['evening'])
    // The returning leg's own hour (fixed at 18:00 in the `flight` helper above) never
    // disqualifies a morning outbound — the window is checked on the outbound leg alone.
    expect(applyFilter([flight('x', 1000, { outboundHour: 9 })], { departure: 'morning' })).toHaveLength(1)
  })

  it('maxPriceMinor and airlines: price applies to both kinds, airlines matches any leg\'s carrier', () => {
    const items = [
      flight('cheap-zz', 20_000, { carriers: ['ZZ'] }),
      flight('pricey-lh', 90_000, { carriers: ['LH'] }),
      hotel('cheap-hotel', 15_000),
      hotel('pricey-hotel', 90_000),
    ]
    expect(applyFilter(items, { maxPriceMinor: '50000' }).map((i) => i.sourceId))
      .toEqual(['cheap-zz', 'cheap-hotel'])
    expect(applyFilter(items, { airlines: ['LH'] }).map((i) => i.sourceId))
      .toEqual(['pricey-lh', 'cheap-hotel', 'pricey-hotel']) // hotels have no carrier to fail the check, so they pass through
  })

  it('maxStops caps every leg, independent of nonstop', () => {
    const items = [
      flight('direct', 1000, { outboundStops: 0, inboundStops: 0 }),
      flight('one-stop', 1000, { outboundStops: 1, inboundStops: 0 }),
      flight('two-stops', 1000, { outboundStops: 2, inboundStops: 0 }),
    ]
    expect(applyFilter(items, { maxStops: 1 }).map((i) => i.sourceId)).toEqual(['direct', 'one-stop'])
  })

  // Results UI pass 2, D. `minCabinBags`/`minCheckedBags` live on `Filter` rather than in the
  // rail's own state so a typed "with a checked bag" can reach the same code; this is the src
  // half of the pin, and `test/web-filters.test.ts` holds the two modules against each other.
  it('minCabinBags/minCheckedBags read the fare\'s own included allowance', () => {
    const items = [
      flight('no-bags', 1000, { cabinBag: 0, checkedBag: 0 }),
      flight('cabin-only', 1000, { cabinBag: 1, checkedBag: 0 }),
      flight('both', 1000, { cabinBag: 1, checkedBag: 1 }),
    ]
    expect(applyFilter(items, { minCabinBags: 1 }).map((i) => i.sourceId)).toEqual(['cabin-only', 'both'])
    expect(applyFilter(items, { minCheckedBags: 1 }).map((i) => i.sourceId)).toEqual(['both'])
    expect(applyFilter(items, { minCabinBags: 0 })).toHaveLength(3)
  })

  it('minRating keeps a rated stay and drops both an unrated one and nothing else', () => {
    const rated = (sourceId: string, rating: number | null): StoredItem => {
      const base = hotel(sourceId, 50_000)
      return { ...base, detail: { ...base.detail, rating } as typeof base.detail }
    }
    const items = [rated('h3', 3), rated('h4', 4), rated('h0', null), flight('f', 50_000)]
    // A flight has nothing to answer a rating with, so it passes through untouched.
    expect(applyFilter(items, { minRating: 4 }).map((i) => i.sourceId)).toEqual(['h4', 'f'])
    expect(applyFilter(items, { minRating: 3 }).map((i) => i.sourceId)).toEqual(['h3', 'h4', 'f'])
  })
})

describe('describeFilter', () => {
  it('builds a fixed phrase from the filter\'s own enums and numbers', () => {
    expect(describeFilter({})).toBe('all results')
    expect(describeFilter({ nonstop: true })).toBe('nonstop')
    expect(describeFilter({ departure: 'evening' })).toBe('evening')
    expect(describeFilter({ maxPriceMinor: '50000' })).toBe('under 500')
    expect(describeFilter({ nonstop: true, departure: 'morning', airlines: ['LH'] })).toBe('nonstop, morning, LH')
  })

  it('names the bag minimums and the rating, and says nothing for a zero minimum', () => {
    expect(describeFilter({ minCabinBags: 1 })).toBe('with a cabin bag')
    expect(describeFilter({ minCheckedBags: 2 })).toBe('with 2 checked bags')
    expect(describeFilter({ minRating: 4 })).toBe('rated 4+')
    expect(describeFilter({ minCabinBags: 0, minCheckedBags: 0 })).toBe('all results')
    expect(describeFilter({ nonstop: true, minCheckedBags: 1 })).toBe('nonstop, with a checked bag')
  })
})
