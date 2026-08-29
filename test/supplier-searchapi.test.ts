import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
  })

  it('uses property_token as the source id so a re-quote can find it', () => {
    expect(items.every((i) => i.sourceId.length > 5)).toBe(true)
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(items.length)
  })

  it('records the price basis it actually read', () => {
    expect(items.every((i) => i.priceBasis === 'total' || i.priceBasis === 'pre_tax')).toBe(true)
  })

  it('derives nights from the search window', () => {
    const d = items[0]!.detail
    expect(d.kind).toBe('hotel')
    if (d.kind !== 'hotel') throw new Error('unreachable')
    expect(d.nights).toBe(7)
    expect(d.checkIn).toBe('2026-09-12')
  })

  it('DROPS a property with no usable price instead of defaulting to zero', () => {
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
      properties: [{
        property_token: 'D', name: 'Pretax only',
        total_price: { extracted_price_before_taxes: 428 },
      }],
    })
    const [only] = parseSearchApiHotels(doc, params, NOW)
    expect(only!.price.minor).toBe(42800n)
    expect(only!.priceBasis).toBe('pre_tax')
  })

  it('converts the float price to exact minor units', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'EUR' },
      properties: [{ property_token: 'E', name: 'X', total_price: { extracted_price: 452.35 } }],
    })
    expect(parseSearchApiHotels(doc, params, NOW)[0]!.price.minor).toBe(45235n)
  })

  it('throws on an API error payload', () => {
    expect(() => parseSearchApiHotels(JSON.stringify({ error: 'bad key' }), params, NOW))
      .toThrow(/bad key/)
  })

  // Correction 1: SearchApi echoes the currency it actually honoured in
  // search_parameters.currency. Kiwi refuses a mismatch instead of relabelling
  // the number with the requested currency (src/supplier/kiwi.ts); this
  // adapter must take the same position, since a silently relabelled price
  // defeats every downstream currency/totals/budget gate.
  it('throws when the response currency does not match the requested currency', () => {
    const doc = JSON.stringify({
      search_parameters: { currency: 'USD' },
      properties: [{ property_token: 'F', name: 'Mismatch', total_price: { extracted_price: 100 } }],
    })
    expect(() => parseSearchApiHotels(doc, params, NOW))
      .toThrow(/requested currency EUR but response is USD/)
  })
})

describe('SearchApiHotels capabilities', () => {
  it('is live and requotable via the stable property token', () => {
    const s = new SearchApiHotels('test-key')
    expect(s.capabilities.live).toBe(true)
    expect(s.capabilities.mayRequote).toBe(true)
  })
  it('refuses to construct without a key rather than failing at request time', () => {
    expect(() => new SearchApiHotels('')).toThrow(/key/i)
  })
})
