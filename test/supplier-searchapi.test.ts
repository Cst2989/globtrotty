import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { parseSearchApiHotels, SearchApiHotels } from '../src/supplier/searchapi.js'
import type { HotelSearch } from '../src/supplier/types.js'

const raw = readFileSync(new URL('./fixtures/searchapi-hotels.json', import.meta.url), 'utf8')
const NOW = new Date('2026-08-16T12:00:00Z')
const params: HotelSearch = {
  kind: 'hotel', query: 'Faro Portugal', checkIn: '2026-09-12',
  checkOut: '2026-09-19', adults: 2, currency: 'EUR',
}

describe('parseSearchApiHotels', () => {
  const items = parseSearchApiHotels(raw, params, NOW)

  it('returns priced hotel items', () => {
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.kind === 'hotel')).toBe(true)
    expect(items.every((i) => i.price.minor > 0n)).toBe(true)
    expect(items.every((i) => i.supplier === 'searchapi')).toBe(true)
    expect(items.every((i) => i.ttlSeconds === 3600)).toBe(true)
  })

  it('uses property_token as the source id so a re-quote can find it', () => {
    expect(items.every((i) => i.sourceId.length > 5)).toBe(true)
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(items.length)
  })

  it('records the price basis it actually read', () => {
    expect(items.every((i) => i.priceBasis === 'total' || i.priceBasis === 'pre_tax')).toBe(true)
  })

  it('derives nights from the search window, never from the response', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('hotel')
    if (d.kind !== 'hotel') throw new Error('unreachable')
    expect(d.nights).toBe(7)
    expect(d.checkIn).toBe('2026-09-12')
    expect(d.checkOut).toBe('2026-09-19')
  })

  it('DROPS a property with no usable price instead of defaulting it to zero', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'EUR' },
      properties: [
        { property_token: 'A', name: 'Priced', total_price: { extracted_price: 100 } },
        { property_token: 'B', name: 'No price at all' },
        { property_token: 'C', name: 'Null price', total_price: { extracted_price: null } },
      ],
    })
    const out = parseSearchApiHotels(doc, params, NOW)
    expect(out.map((i) => i.sourceId)).toEqual(['A'])
    expect(out.some((i) => i.price.minor === 0n)).toBe(false)
  })

  it('falls back to pre-tax and labels it, rather than silently mixing bases', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'EUR' },
      properties: [{ property_token: 'D', name: 'Pretax only', total_price: { extracted_price_before_taxes: 428 } }],
    })
    const [only] = parseSearchApiHotels(doc, params, NOW)
    expect(only!.price.minor).toBe(42800n)
    expect(only!.priceBasis).toBe('pre_tax')
  })

  // 452.35 * 100 is exactly 45235 in IEEE-754, so a value like that does not
  // discriminate: round and trunc agree on it. These two do not.
  it('rounds rather than truncates a price that goes inexact under a float multiply', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'EUR' },
      properties: [
        { property_token: 'E', name: 'X', total_price: { extracted_price: 8.29 } },
        { property_token: 'F', name: 'Y', total_price: { extracted_price: 70.07 } },
      ],
    })
    const [first, second] = parseSearchApiHotels(doc, params, NOW)
    expect(first!.price.minor).toBe(829n)
    expect(second!.price.minor).toBe(7007n)
  })

  it('throws on an API error payload', () => {
    expect(() => parseSearchApiHotels(JSON.stringify({ error: 'bad key' }), params, NOW))
      .toThrow(/bad key/)
  })

  it('throws when the response currency does not match the requested currency', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'USD' },
      properties: [{ property_token: 'G', name: 'Mismatch', total_price: { extracted_price: 100 } }],
    })
    expect(() => parseSearchApiHotels(doc, params, NOW))
      .toThrow(/requested currency EUR but response is USD/)
  })

  /**
   * The absent case, distinct from the mismatched one, for the same reason
   * Kiwi's is: `if (echoed && echoed !== requested)` treats a missing field as
   * agreement and stamps the requested code onto whatever number came back.
   */
  it('refuses a response that does not say what currency it priced in', () => {
    const missing = JSON.stringify({
      properties: [{ property_token: 'H', name: 'Silent', total_price: { extracted_price: 100 } }],
    })
    expect(() => parseSearchApiHotels(missing, params, NOW))
      .toThrow(/requested currency EUR but response is absent/)

    // Present, but with no currency key. The same fault, one level down.
    const emptyParams = JSON.stringify({
      search_parameters: { q: 'Faro Portugal' },
      properties: [{ property_token: 'I', name: 'Silent', total_price: { extracted_price: 100 } }],
    })
    expect(() => parseSearchApiHotels(emptyParams, params, NOW)).toThrow(/absent/)
  })

  // The other side of the boundary: an echo that agrees still parses, so "throw
  // on everything" cannot pass the two tests above.
  it('accepts a response whose currency echo matches the request', () => {
    expect(parseSearchApiHotels(raw, params, NOW).length).toBeGreaterThan(0)
  })

  it('never puts a supplier-supplied link anywhere but bookingUrl', () => {
    // The link is kept because module 7 will want to know what the supplier
    // said, and it is never emitted: lesson 4.6 builds every URL she clicks.
    const doc = JSON.stringify({
      search_parameters: { currency: 'EUR' },
      properties: [{ property_token: 'J', name: 'Linked', link: 'https://anything.example/x',
                     total_price: { extracted_price: 100 } }],
    })
    const [only] = parseSearchApiHotels(doc, params, NOW)
    expect(only!.bookingUrl).toBe('https://anything.example/x')
  })
})

describe('SearchApiHotels', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is live and requotable via the stable property token', () => {
    const s = new SearchApiHotels('test-key')
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
    expect(s.capabilities.maxAgeSeconds).toBe(3600)
    expect(s.kind).toBe('hotel')
  })

  it('refuses to construct without a key rather than failing at request time', () => {
    // A missing key discovered mid-turn costs a turn; discovered at boot it
    // costs a restart.
    expect(() => new SearchApiHotels('')).toThrow(/key/i)
  })

  it('sends the search as query parameters, key included, and passes the abort signal', async () => {
    let seenUrl: string | undefined
    let seenSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url)
      seenSignal = init?.signal ?? undefined
      return { ok: true, text: async () => JSON.stringify({ search_parameters: { currency: 'EUR' }, properties: [] }) } as Response
    }))
    const controller = new AbortController()
    await new SearchApiHotels('k-123').search(params, controller.signal)
    const url = new URL(seenUrl!)
    expect(url.hostname).toBe('www.searchapi.io')
    expect(url.searchParams.get('engine')).toBe('google_hotels')
    expect(url.searchParams.get('check_in_date')).toBe('2026-09-12')
    expect(url.searchParams.get('currency')).toBe('EUR')
    expect(url.searchParams.get('api_key')).toBe('k-123')
    expect(seenSignal).toBe(controller.signal)
  })

  it('turns a failed re-quote into unavailable rather than a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const q = await new SearchApiHotels('k').quote('anything', params)
    expect(q.status).toBe('unavailable')
  })
})
