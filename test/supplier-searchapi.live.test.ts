// Opt-in live smoke test: hits the real SearchApi.io Google Hotels endpoint. A
// fixture proves the parser; it cannot prove the endpoint still speaks the
// shape the parser expects. Gated on LIVE_SUPPLIERS so the default `pnpm test`
// run stays offline — same pattern as test/supplier-kiwi.live.test.ts.
import { describe, expect, it } from 'vitest'
import { SearchApiHotels } from '../src/supplier/searchapi.js'
import type { HotelSearch } from '../src/supplier/types.js'

const live = process.env.LIVE_SUPPLIERS === '1' ? describe : describe.skip

// Kept comfortably in the future so the search never goes empty as time passes.
const checkIn = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
const checkOut = new Date(Date.now() + 67 * 86_400_000).toISOString().slice(0, 10)

const params: HotelSearch = {
  kind: 'hotel', query: 'Faro Portugal', checkIn, checkOut, adults: 2, currency: 'EUR',
}

live('SearchApiHotels (live)', () => {
  const apiKey = process.env.GOOGLE_SEARCH_API
  if (!apiKey) throw new Error('LIVE_SUPPLIERS=1 requires GOOGLE_SEARCH_API to be set')

  it('returns priced hotels in the requested currency, on the requested window, with a strict shape', async () => {
    const items = await new SearchApiHotels(apiKey).search(params)
    expect(items.length).toBeGreaterThan(0)

    // Price: never a float leaving the adapter. Do not pin an exact amount —
    // real prices move — but the type, sign and currency are load-bearing.
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
      expect(i.priceBasis === 'total' || i.priceBasis === 'pre_tax').toBe(true)
    }

    // Ids: non-empty and unique per item, since quote() finds by id.
    const ids = items.map((i) => i.sourceId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    // Nights are derived from the requested window, never from the response.
    for (const i of items) {
      expect(i.detail.kind).toBe('hotel')
      if (i.detail.kind !== 'hotel') continue
      expect(i.detail.checkIn).toBe(checkIn)
      expect(i.detail.checkOut).toBe(checkOut)
      expect(i.detail.nights).toBe(7)
    }
  }, 90_000)

  it('re-quotes a just-searched id to ok — the property mayRequote claims', async () => {
    const s = new SearchApiHotels(apiKey)
    const [first] = await s.search(params)
    expect(first).toBeDefined()
    const q = await s.quote(first!.sourceId, params)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') {
      expect(q.item.sourceId).toBe(first!.sourceId)
      expect(q.item.price.currency).toBe('EUR')
      expect(q.item.price.minor > 0n).toBe(true)
    }
  }, 90_000)

  it('reports an unknown id as gone, not as an error', async () => {
    const q = await new SearchApiHotels(apiKey).quote('definitely-not-a-property-token', params)
    expect(q.status).toBe('gone')
  }, 90_000)
})
