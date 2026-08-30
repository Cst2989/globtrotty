import { SearchApiHotels } from '../src/supplier/searchapi.js'
import type { HotelSearch } from '../src/supplier/types.js'
import { describeLive, requireSearchApiKey } from './helpers/live.js'

const checkIn = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
const checkOut = new Date(Date.now() + 67 * 86_400_000).toISOString().slice(0, 10)

const params: HotelSearch = {
  kind: 'hotel', query: 'Faro Portugal', checkIn, checkOut, adults: 2, currency: 'EUR',
}

describeLive('SearchApiHotels (live)', () => {
  it('returns priced hotels in the requested currency, over the requested window', async () => {
    // Inside the `it`, never in the describe callback. See test/helpers/live.ts.
    const items = await new SearchApiHotels(requireSearchApiKey()).search(params)
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
      expect(i.priceBasis === 'total' || i.priceBasis === 'pre_tax').toBe(true)
    }
    const ids = items.map((i) => i.sourceId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const i of items) {
      if (i.detail.kind !== 'hotel') continue
      expect(i.detail.checkIn).toBe(checkIn)
      expect(i.detail.nights).toBe(7)
    }
  }, 90_000)

  it('re-quotes a just-searched id to ok, which is the property mayRequote claims', async () => {
    const s = new SearchApiHotels(requireSearchApiKey())
    const [first] = await s.search(params)
    expect(first).toBeDefined()
    const q = await s.quote(first!.sourceId, params)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.sourceId).toBe(first!.sourceId)
  }, 90_000)

  it('reports an unknown id as gone, not as an error', async () => {
    const q = await new SearchApiHotels(requireSearchApiKey()).quote('definitely-not-a-property-token', params)
    expect(q.status).toBe('gone')
  }, 90_000)
})
