import { KiwiSupplier } from '../src/supplier/kiwi.js'
import type { FlightSearch } from '../src/supplier/types.js'
import { describeLive } from './helpers/live.js'

// Comfortably in the future, so the search never goes empty as time passes.
const departureDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
const returnDate = new Date(Date.now() + 67 * 86_400_000).toISOString().slice(0, 10)

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate, returnDate, flexDays: 0,
  adults: 1, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

describeLive('KiwiSupplier (live)', () => {
  it('returns priced itineraries in the requested currency, on the requested date', async () => {
    const items = await new KiwiSupplier().search(params)
    expect(items.length).toBeGreaterThan(0)

    // Never pin an exact amount: real prices move. The type, the sign and the
    // currency are what the parser promises and they do not.
    for (const i of items) {
      expect(typeof i.price.minor).toBe('bigint')
      expect(i.price.minor > 0n).toBe(true)
      expect(i.price.currency).toBe('EUR')
    }

    const ids = items.map((i) => i.sourceId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    for (const i of items) {
      if (i.detail.kind !== 'flight') continue
      for (const leg of [i.detail.outbound, i.detail.inbound]) {
        if (!leg) continue
        expect(leg.departureLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
        expect(leg.departureLocal).not.toMatch(/Z|[+-]\d{2}:\d{2}$/)
        expect(leg.arrivalLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      }
      // Proves the dd/mm/yyyy conversion actually reached Kiwi. Without the
      // conversion the endpoint either returns nothing (caught above) or
      // returns flights that do not depart on the requested date.
      expect(i.detail.outbound.departureLocal.slice(0, 10)).toBe(departureDate)
    }
  }, 90_000)

  it('re-quotes a just-searched id to ok, which is the property mayRequote claims', async () => {
    const s = new KiwiSupplier()
    const [first] = await s.search(params)
    expect(first).toBeDefined()
    const q = await s.quote(first!.sourceId, params)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') {
      expect(q.item.sourceId).toBe(first!.sourceId)
      expect(q.item.price.minor > 0n).toBe(true)
    }
  }, 180_000)

  it('reports an unknown id as gone, not as an error', async () => {
    expect((await new KiwiSupplier().quote('definitely-not-an-itinerary', params)).status).toBe('gone')
  }, 90_000)
})
