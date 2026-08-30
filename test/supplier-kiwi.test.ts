import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKiwiResponse, toKiwiDate, KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'

describe('what a naive parse of a supplier response does', () => {
  it('loses a cent turning a float price into minor units', () => {
    // The fixture's own prices are whole euros, so round and trunc agree on
    // every one of them and neither is visibly wrong. These two are not, and
    // they are ordinary supplier prices.
    expect(8.29 * 100).toBe(828.9999999999999)
    expect(70.07 * 100).toBe(7006.999999999999)
    expect(Math.trunc(8.29 * 100)).toBe(828)      // one cent, silently
    expect(Math.round(8.29 * 100)).toBe(829)
  })

  it('moves a departure to the wrong day when a naive timestamp is parsed as a Date', () => {
    // Kiwi returns local time with NO offset. The suite pins
    // TZ=America/Los_Angeles (vitest.config.ts), which is what makes this
    // visible here rather than on somebody's machine in production.
    const departure = '2026-09-20T23:59:00'
    // The correct answer, and the only one that needs no zone at all.
    expect(departure.slice(0, 10)).toBe('2026-09-20')
    // What `new Date(...)` says instead, once the server's zone is applied and
    // the instant is written back out in UTC.
    expect(new Date(departure).toISOString().slice(0, 10)).toBe('2026-09-21')
  })
})

const sse = readFileSync(new URL('./fixtures/kiwi-search.sse', import.meta.url), 'utf8')
const NOW = new Date('2026-08-16T12:00:00Z')
const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

/** One SSE frame carrying one JSON-RPC reply carrying one JSON string. Three envelopes, like the real thing. */
function frame(payload: unknown): string {
  return 'data: ' + JSON.stringify({
    jsonrpc: '2.0', id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  })
}

/** A minimal itinerary, so each test below varies one field and nothing else. */
function itinerary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'synthetic-1', price: 100, totalDurationSeconds: 100, bookingUrl: null,
    baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
    outbound: {
      from: 'BER', to: 'FAO',
      departureTime: '2026-09-12T10:00:00', arrivalTime: '2026-09-12T12:00:00',
      stops: 0, route: ['BER', 'FAO'], cabinClass: 'Economy', segments: [],
    },
    inbound: null,
    ...over,
  }
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
    // minor-unit value is 46400n. A Math.trunc implementation would still pass
    // a typeof and positivity check, so this pins the exact number.
    expect(items[0]!.price.minor).toBe(46400n)
    expect(items[0]!.price.currency).toBe('EUR')
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
    }
  })

  // The fixture's prices are all whole euros, so round and trunc agree on every
  // one of them and a trunc regression slips through against the fixture alone.
  // These two prices genuinely go inexact under a binary-float multiply, which
  // is the case step 1 demonstrated. Do not delete this as redundant with the
  // fixture test above: it covers a different, real IEEE-754 case.
  it('rounds rather than truncates a price that goes inexact under a float multiply', () => {
    const doc = frame({
      currency: 'EUR',
      itineraries: [
        itinerary({ id: 'inexact-1', price: 8.29 }),
        itinerary({ id: 'inexact-2', price: 70.07 }),
      ],
    })
    const out = parseKiwiResponse(doc, params, NOW)
    expect(out[0]!.price.minor).toBe(829n)
    expect(out[1]!.price.minor).toBe(7007n)
  })

  it('keeps leg times as naive strings, never Dates', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('flight')
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(typeof d.outbound.departureLocal).toBe('string')
    expect(d.outbound.departureLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(d.outbound.departureLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
  })

  it('preserves the native id verbatim, unique per item, so a re-quote can find it', () => {
    expect(items[0]!.sourceId.length).toBeGreaterThan(10)
    const ids = items.map((i) => i.sourceId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('stamps fetchedAt from the injected clock, not wall time', () => {
    expect(items[0]!.fetchedAt.toISOString()).toBe(NOW.toISOString())
    expect(items[0]!.ttlSeconds).toBe(900)
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
    expect(() => parseKiwiResponse(frame({ error: 'no route', itineraries: [] }), params, NOW))
      .toThrow(/no route/)
  })

  it('rejects a currency the response did not honour', () => {
    expect(() => parseKiwiResponse(frame({ currency: 'USD', itineraries: [] }), params, NOW))
      .toThrow(/currency/i)
  })

  /**
   * A MISSING currency echo is a separate case from a mismatched one, and the
   * obvious guard (`if (data.currency && data.currency !== requested)`) treats
   * it as agreement: the requested code gets stamped onto whatever number came
   * back. That is "absence of evidence is confirmation", and it contradicts
   * every other position in this branch. `checkFreshness` (lesson 4.5) calls an
   * unparseable timestamp stale; `quote()` calls a transport failure
   * unavailable. Unknown is not unchanged.
   */
  it('refuses a response that does not say what currency it priced in', () => {
    const silent = frame({ itineraries: [itinerary({ id: 'no-currency-1' })] })
    // Pinned on 'absent', not merely /currency/i: a mismatch message would also
    // satisfy a loose regex, and the whole point is that this is the ABSENT case.
    expect(() => parseKiwiResponse(silent, params, NOW)).toThrow(/absent/)
    expect(() => parseKiwiResponse(silent, params, NOW)).toThrow(/EUR/)
  })

  // The other side of the boundary: an echo that agrees still parses. Without
  // this, "throw on everything" would pass the two tests above.
  it('accepts a response whose currency echo matches the request', () => {
    expect(parseKiwiResponse(sse, params, NOW).length).toBeGreaterThan(0)
  })

  /**
   * Lesson 4.6's cashier compares a re-quote on item identity, and a refundable
   * fare downgraded to basic economy differs by flight number while carrier,
   * route and times can all stay put. Every fixture segment carries one.
   */
  it('keeps every segment flight number, in order, on both legs', () => {
    const d = items[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.outbound.flightNumbers).toEqual(['U22202', 'LS875'])
    expect(d.inbound!.flightNumbers).toEqual(['FR1762', 'FR1638'])
    // Distinct from `carriers`, which IS a deduplicated set of operators. The
    // inbound leg is the discriminator: both its segments are Ryanair, so
    // `carriers` collapses to one entry while `flightNumbers` keeps two. A
    // copy-paste of the `carriers` expression fails here.
    expect(d.outbound.carriers).toEqual(['U2', 'LS'])
    expect(d.inbound!.carriers).toEqual(['FR'])
  })

  it('yields an empty flight-number list rather than blanks when segments omit it', () => {
    const doc = frame({
      currency: 'EUR',
      itineraries: [itinerary({
        id: 'no-flight-numbers',
        outbound: { ...(itinerary().outbound as Record<string, unknown>), segments: [{ carrier: 'FR' }] },
      })],
    })
    const d = parseKiwiResponse(doc, params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.outbound.flightNumbers).toEqual([])   // not [''], and not undefined
  })

  /**
   * A zero price passes a bare `Number.isFinite` check and is then the cheapest
   * option in every budget and ranking comparison: the most attractive possible
   * answer, and an entirely fictional one. There is no fallback price to fall
   * back to here, so the whole response is refused.
   */
  it.each([[0], [-1], [-0.01]])('refuses an itinerary priced %p', (price) => {
    const doc = frame({ currency: 'EUR', itineraries: [itinerary({ id: 'zero-price', price })] })
    expect(() => parseKiwiResponse(doc, params, NOW)).toThrow(/unusable price/)
  })

  // The other side of that boundary: the smallest representable positive price
  // is legal and converts exactly. `> 0` must not have become `>= 1`.
  it('accepts the smallest positive price', () => {
    const doc = frame({ currency: 'EUR', itineraries: [itinerary({ id: 'one-cent', price: 0.01 })] })
    expect(parseKiwiResponse(doc, params, NOW)[0]!.price.minor).toBe(1n)
  })

  /**
   * Baggage is load bearing for a recommendation: a 30 EUR fare with no cabin
   * bag is not cheaper than a 55 EUR fare with one. The field was typed as
   * required and never checked, so a response that omitted it produced
   * `detail.baggage === undefined`, which reads downstream as "we have no idea"
   * and renders as nothing at all. Zero is the honest floor: it claims no
   * allowance we were not told about.
   */
  it('defaults a missing baggage block to zeroes rather than undefined', () => {
    const withoutBaggage = itinerary({ id: 'no-baggage' })
    delete withoutBaggage.baggage
    const d = parseKiwiResponse(frame({ currency: 'EUR', itineraries: [withoutBaggage] }), params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.baggage).toEqual({ personalItem: 0, cabinBag: 0, checkedBag: 0 })
  })

  it('fills only the missing baggage counts, keeping the ones that were given', () => {
    const doc = frame({ currency: 'EUR', itineraries: [itinerary({ id: 'partial-baggage', baggage: { checkedBag: 2 } })] })
    const d = parseKiwiResponse(doc, params, NOW)[0]!.detail
    if (d.kind !== 'flight') throw new Error('unreachable')
    expect(d.baggage).toEqual({ personalItem: 0, cabinBag: 0, checkedBag: 2 })
  })
})

describe('KiwiSupplier capabilities', () => {
  it('declares itself live and requotable', () => {
    const s = new KiwiSupplier()
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
    expect(s.capabilities.maxAgeSeconds).toBe(900)
    expect(s.name).toBe('kiwi')
    expect(s.kind).toBe('flight')
  })
})

describe('KiwiSupplier request wiring', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /**
   * Nothing else exercises the request body, so a regression that dropped the
   * `toKiwiDate(...)` wrapper and sent ISO yyyy-mm-dd would pass every other
   * test in the repository while silently breaking every live search. Intercept
   * fetch and pin the exact body it sends.
   */
  it('sends departureDate and returnDate to Kiwi in dd/mm/yyyy, not ISO', async () => {
    const empty = frame({ currency: 'EUR', itineraries: [] })
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
    expect(args.departureDate).toBe('12/09/2026')
    expect(args.returnDate).toBe('19/09/2026')
    expect(args.departureDate).not.toBe(params.departureDate)
    expect(args.departureDate).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('passes the caller\'s abort signal down to fetch', async () => {
    // Lesson 4.2's other half: a fenced worker's in-flight supplier call has to
    // be cancellable, and this is the only place in the chain that can hand the
    // signal to the platform.
    const empty = frame({ currency: 'EUR', itineraries: [] })
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return { ok: true, text: async () => empty } as Response
    }))
    const controller = new AbortController()
    await new KiwiSupplier().search(params, controller.signal)
    expect(seen).toBe(controller.signal)
  })

  it('reports a non-2xx as an error naming the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' } as Response)))
    await expect(new KiwiSupplier().search(params)).rejects.toThrow(/HTTP 503/)
  })

  it('turns a failed re-quote into unavailable rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const q = await new KiwiSupplier().quote('anything', params)
    expect(q.status).toBe('unavailable')
    if (q.status === 'unavailable') expect(q.reason).toMatch(/network down/)
  })

  it('reports an id the re-search did not return as gone, not as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: true, text: async () => frame({ currency: 'EUR', itineraries: [] }) } as Response
    )))
    expect((await new KiwiSupplier().quote('not-in-this-search', params)).status).toBe('gone')
  })
})
