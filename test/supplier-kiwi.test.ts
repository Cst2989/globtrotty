import { afterEach, describe, expect, it, vi } from 'vitest'
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

  /**
   * A MISSING currency echo is refused too, and that is a separate case from a
   * mismatched one. The old guard was `if (data.currency && data.currency !==
   * requested)`, so an absent field skipped the check entirely and the
   * requested code was stamped onto whatever number came back — "absence of
   * evidence is confirmation". That contradicts this codebase's own posture
   * everywhere else: `checkFreshness` calls an unparseable timestamp STALE, and
   * `quote()` calls a transport failure `unavailable`, because unknown is not
   * unchanged.
   *
   * The captured fixture always carries `currency: "EUR"`, so this costs
   * nothing against the real API — which is exactly why the missing case needs
   * a synthetic payload to be covered at all.
   */
  it('refuses a response that does not say what currency it priced in', () => {
    const silent = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        // No `currency` key at all.
        itineraries: [{
          id: 'no-currency-1', price: 100, totalDurationSeconds: 100, bookingUrl: null,
          baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
          },
          inbound: null,
        }],
      }) }] },
    })
    // Pinned on 'absent', not merely /currency/i: a mismatch message would also
    // match a loose regex, and the whole point is that this is the ABSENT case.
    expect(() => parseKiwiResponse(silent, params, NOW)).toThrow(/absent/)
    // And the itinerary must not have been returned priced in the requested
    // currency, which is precisely what the old truthiness guard did.
    expect(() => parseKiwiResponse(silent, params, NOW)).toThrow(/EUR/)
  })

  // The other side of the boundary: an echo that agrees still parses. Without
  // this, "throw on everything" would pass the test above.
  it('accepts a response whose currency echo matches the request', () => {
    expect(parseKiwiResponse(sse, params, NOW).length).toBeGreaterThan(0)
  })

  /**
   * §6 names `flight_no` in the normalised corpus shape, and §5's cashier must
   * compare "per item and on item identity, not just on the sum" — a refundable
   * fare and basic economy differ by flight number while carrier, route and
   * times can all stay put. Every fixture segment carries `flightNumber`; the
   * parse used to drop it.
   */
  it('keeps every segment flight number, in order, on both legs', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    // Pinned to the fixture's exact values and exact order. A dedupe, a sort,
    // or a "first segment only" implementation all fail this.
    expect(d.outbound.flightNumbers).toEqual(['U22202', 'LS875'])
    expect(d.inbound!.flightNumbers).toEqual(['FR1762', 'FR1638'])
    // Distinct from `carriers`, which IS a deduped set of operators. The
    // inbound leg is the discriminator: both segments are Ryanair, so
    // `carriers` collapses to one entry while `flightNumbers` must keep two.
    // A copy-paste of the `carriers` expression would fail here.
    expect(d.outbound.carriers).toEqual(['U2', 'LS'])
    expect(d.inbound!.carriers).toEqual(['FR'])
  })

  it('yields an empty flight-number list rather than blanks when segments omit it', () => {
    const noNumbers = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [{
          id: 'no-flight-numbers', price: 100, totalDurationSeconds: 100, bookingUrl: null,
          baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy',
            segments: [{ carrier: 'FR' }],
          },
          inbound: null,
        }],
      }) }] },
    })
    const d = parseKiwiResponse(noNumbers, params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.outbound.flightNumbers).toEqual([])   // not [''], and not undefined
  })

  /**
   * A zero price would pass a bare `Number.isFinite` check and then be the
   * cheapest option in every budget and ranking comparison — the most
   * attractive possible answer, and entirely fictional. `pickPrice` in
   * searchapi.ts already guards with `total > 0`; this makes Kiwi symmetric.
   */
  it.each([[0], [-1], [-0.01]])('refuses an itinerary priced %p', (price) => {
    const doc = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [{
          id: 'zero-price', price, totalDurationSeconds: 100, bookingUrl: null,
          baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
          },
          inbound: null,
        }],
      }) }] },
    })
    expect(() => parseKiwiResponse(doc, params, NOW)).toThrow(/unusable price/)
  })

  // The other side of that boundary: the smallest representable positive price
  // is legal and converts exactly. `> 0` must not have become `>= 1`.
  it('accepts the smallest positive price', () => {
    const doc = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [{
          id: 'one-cent', price: 0.01, totalDurationSeconds: 100, bookingUrl: null,
          baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
          },
          inbound: null,
        }],
      }) }] },
    })
    expect(parseKiwiResponse(doc, params, NOW)[0]!.price.minor).toBe(1n)
  })

  /**
   * §13 makes baggage load-bearing for the recommendation, and the field was
   * typed as required but never checked — a response that omitted it produced
   * `detail.baggage === undefined`, which renders as nothing at all rather than
   * as "no allowance". Zero is the honest floor: it claims nothing we were not
   * told.
   */
  it('defaults a missing baggage block to zeroes rather than undefined', () => {
    const doc = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [{
          id: 'no-baggage', price: 100, totalDurationSeconds: 100, bookingUrl: null,
          // No `baggage` key at all.
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
          },
          inbound: null,
        }],
      }) }] },
    })
    const d = parseKiwiResponse(doc, params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.baggage).toEqual({ personalItem: 0, cabinBag: 0, checkedBag: 0 })
  })

  it('fills only the missing baggage counts, keeping the ones that were given', () => {
    const doc = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        currency: 'EUR',
        itineraries: [{
          id: 'partial-baggage', price: 100, totalDurationSeconds: 100, bookingUrl: null,
          baggage: { checkedBag: 2 },
          outbound: {
            from: 'BER', to: 'FAO',
            departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
            stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
          },
          inbound: null,
        }],
      }) }] },
    })
    const d = parseKiwiResponse(doc, params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    // 2 survives; the two absent counts become 0, not undefined.
    expect(d.baggage).toEqual({ personalItem: 0, cabinBag: 0, checkedBag: 2 })
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

describe('KiwiSupplier request wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Task 5's review flagged this as untested: nothing exercised the request
  // body construction, so a regression that dropped the `toKiwiDate(...)`
  // wrapper and sent `p.departureDate`/`p.returnDate` as ISO yyyy-mm-dd would
  // pass every other test in the repo while silently breaking every live
  // search (Kiwi expects dd/mm/yyyy). Intercept fetch and pin the exact
  // request body it sends.
  it('sends departureDate and returnDate to Kiwi in dd/mm/yyyy, not ISO', async () => {
    const empty = 'data: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ currency: 'EUR', itineraries: [] }) }] },
    })
    let capturedBody: unknown
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return { ok: true, text: async () => empty } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await new KiwiSupplier().search(params)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const args = (capturedBody as {
      params: { arguments: { departureDate: string; returnDate: string } }
    }).params.arguments

    // params.departureDate/returnDate are ISO '2026-09-12'/'2026-09-19'.
    // toKiwiDate converts to dd/mm/yyyy: '12/09/2026'/'19/09/2026'.
    expect(args.departureDate).toBe('12/09/2026')
    expect(args.returnDate).toBe('19/09/2026')

    // Belt-and-braces: explicitly rule out the ISO string leaking through,
    // which is exactly the regression this test exists to catch.
    expect(args.departureDate).not.toBe(params.departureDate)
    expect(args.returnDate).not.toBe(params.returnDate)
    expect(args.departureDate).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
