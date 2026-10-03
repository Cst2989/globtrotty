// Plan 5, Task 9. `applyFilterLite`/`priceSteps`/`priceRange` are pure, so
// they are tested directly here, no DB and no rendering required.
import { describe, expect, it } from 'vitest'
import { applyFilterLite, priceSteps, priceRange } from '../web/filters.js'
import type { ResultItemLite } from '../web/data.js'

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
      outbound: { from: 'BCN', to: 'HND', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-20T10:20:00', via: ['DOH'] },
      inbound: null,
      stops: 1,
      durationMinutes: 855,
      airlines: ['QR'],
      bags: { cabin: 1, checked: 1 },
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
    const morning = flight({ sourceId: 'FA', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T07:05:00', arrivalLocal: '2026-11-19T09:00:00', via: [] } } })
    const evening = flight({ sourceId: 'FB', flight: { outbound: { from: 'A', to: 'B', departureLocal: '2026-11-19T21:00:00', arrivalLocal: '2026-11-19T23:00:00', via: [] } } })
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
