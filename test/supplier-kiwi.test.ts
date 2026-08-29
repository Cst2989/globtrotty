import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKiwiResponse, toKiwiDate, KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'

const sse = readFileSync(new URL('./fixtures/kiwi-search.sse', import.meta.url), 'utf8')
const NOW = new Date('2026-08-16T12:00:00Z')
const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

describe('toKiwiDate', () => {
  it('converts ISO to dd/mm/yyyy', () => {
    expect(toKiwiDate('2026-09-12')).toBe('12/09/2026')
    expect(toKiwiDate('2026-01-05')).toBe('05/01/2026')
  })
  it('rejects a non-ISO input rather than guessing', () => {
    expect(() => toKiwiDate('12/09/2026')).toThrow(/ISO/i)
    expect(() => toKiwiDate('2026-9-12')).toThrow(/ISO/i)
  })
})

describe('parseKiwiResponse', () => {
  const items = parseKiwiResponse(sse, params, NOW)

  it('finds the payload inside the SSE envelope', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  it('converts the float price to exact minor units', () => {
    // The fixture's first itinerary is priced 464.0 EUR. The ONLY correct
    // minor-unit value is 46400n. A Math.trunc implementation would still
    // pass a typeof/positivity check, so this pins the exact number: any
    // rounding bug (e.g. landing on 46399n from a binary-float artifact)
    // must fail this assertion.
    expect(items[0]!.price.minor).toBe(46400n)
    expect(items[0]!.price.currency).toBe('EUR')
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
    }
  })

  // The captured fixture's prices are all whole euros (464.0, 472.0, ...), so
  // `Math.round` and `Math.trunc` agree on every one of them — a Math.trunc
  // regression would slip through undetected against the fixture alone. This
  // test uses a crafted synthetic response with prices that genuinely go
  // inexact under a binary-float `*100` multiply, to actually discriminate
  // round vs. trunc. Do not "simplify" this away as redundant with the
  // fixture-driven test above; it covers a different, real IEEE-754 case.
  it('rounds (not truncates) prices that go inexact under a float *100 multiply', () => {
    // 8.29 * 100 === 828.9999999999999 in IEEE-754 double precision (round -> 829, trunc -> 828)
    // 70.07 * 100 === 7006.999999999999 (round -> 7007, trunc -> 7006)
    // Verified live via `node -e` before relying on them.
    const inexact = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [
          {
            id: 'synthetic-inexact-1', price: 8.29, totalDurationSeconds: 100,
            bookingUrl: null,
            baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
            outbound: {
              from: 'BER', to: 'FAO',
              departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
              stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
            },
            inbound: null,
          },
          {
            id: 'synthetic-inexact-2', price: 70.07, totalDurationSeconds: 100,
            bookingUrl: null,
            baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
            outbound: {
              from: 'BER', to: 'FAO',
              departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
              stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
            },
            inbound: null,
          },
        ],
      }) }] },
    })
    const inexactItems = parseKiwiResponse(inexact, params, NOW)
    expect(inexactItems[0]!.price.minor).toBe(829n)
    expect(inexactItems[1]!.price.minor).toBe(7007n)
  })

  it('keeps leg times as naive strings, never Dates', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('flight')
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(typeof d.outbound.departureLocal).toBe('string')
    expect(d.outbound.departureLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(d.outbound.departureLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
  })

  it('carries baggage counts through, including zeroes', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.baggage).toEqual(expect.objectContaining({
      personalItem: expect.any(Number), cabinBag: expect.any(Number),
      checkedBag: expect.any(Number),
    }))
  })

  it('preserves the native id verbatim, unique per item, so a re-quote can find it', () => {
    expect(items[0]!.sourceId.length).toBeGreaterThan(10)
    expect(typeof items[0]!.sourceId).toBe('string')
    const ids = items.map((i) => i.sourceId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('stamps fetchedAt from the injected clock, not wall time', () => {
    expect(items[0]!.fetchedAt.toISOString()).toBe(NOW.toISOString())
  })

  it('records selfTransfer from the request, since the API does not echo it', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.selfTransfer).toBe(false)
    const allowed = parseKiwiResponse(sse, { ...params, allowSelfTransfer: true }, NOW)
    const d2 = allowed[0]!.detail
    if (d2.kind !== 'flight') throw new Error('unreachable')
    expect(d2.selfTransfer).toBe(true)
  })

  it('throws on an error payload rather than returning an empty list', () => {
    const bad = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ error: 'no route', itineraries: [] }) }] },
    })
    expect(() => parseKiwiResponse(bad, params, NOW)).toThrow(/no route/)
  })

  it('rejects a currency the response did not honour', () => {
    const wrong = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'USD', itineraries: [], resultsCount: 0,
      }) }] },
    })
    expect(() => parseKiwiResponse(wrong, { ...params, currency: 'EUR' }, NOW))
      .toThrow(/currency/i)
  })
})

describe('KiwiSupplier capabilities', () => {
  it('declares itself live and requotable', () => {
    const s = new KiwiSupplier()
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
    expect(s.capabilities.maxAgeSeconds).toBeGreaterThan(0)
  })
})
