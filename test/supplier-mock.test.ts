import { describe, expect, it } from 'vitest'
import { MockSupplier } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const search: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO',
  departureDate: '2026-09-12', returnDate: '2026-09-19', flexDays: 0,
  adults: 2, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

describe('MockSupplier', () => {
  it('is deterministic: the same params yield the same ids and prices', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' }).search(search)
    expect(a.map((i) => i.sourceId)).toEqual(b.map((i) => i.sourceId))
    expect(a.map((i) => i.price.minor)).toEqual(b.map((i) => i.price.minor))
    expect(a.length).toBeGreaterThan(0)
  })

  it('varies with the params, so two searches are not silently identical', async () => {
    const a = await new MockSupplier({ kind: 'flight' }).search(search)
    const b = await new MockSupplier({ kind: 'flight' })
      .search({ ...search, to: 'LIS' })
    expect(a[0]!.sourceId).not.toBe(b[0]!.sourceId)
  })

  it('prices in the requested currency', async () => {
    const items = await new MockSupplier({ kind: 'flight' })
      .search({ ...search, currency: 'GBP' })
    expect(items.every((i) => i.price.currency === 'GBP')).toBe(true)
  })

  it('quotes an existing id as ok with the same price', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') expect(q.item.price.minor).toBe(first!.price.minor)
  })

  it('quotes an unknown id as gone', async () => {
    const s = new MockSupplier({ kind: 'flight' })
    await s.search(search)
    expect((await s.quote('no-such-id', search)).status).toBe('gone')
  })

  it('can be configured to move a price between search and quote', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteDriftMinor: 5000n })
    const [first] = await s.search(search)
    const q = await s.quote(first!.sourceId, search)
    expect(q.status).toBe('ok')
    if (q.status === 'ok') {
      expect(q.item.price.minor).toBe(first!.price.minor + 5000n)
    }
  })

  it('can be configured to fail a quote — unknown is not unchanged', async () => {
    const s = new MockSupplier({ kind: 'flight', quoteMode: 'throw' })
    const [first] = await s.search(search)
    await expect(s.quote(first!.sourceId, search)).rejects.toThrow(/quote failed/i)

    const u = new MockSupplier({ kind: 'flight', quoteMode: 'unavailable' })
    const [f2] = await u.search(search)
    expect((await u.quote(f2!.sourceId, search)).status).toBe('unavailable')
  })

  it('can declare itself non-requotable', () => {
    expect(new MockSupplier({ kind: 'flight', mayRequote: false })
      .capabilities.mayRequote).toBe(false)
    expect(new MockSupplier({ kind: 'flight' }).capabilities.mayRequote).toBe(true)
  })

  it('produces hotel items with nights derived from the date range', async () => {
    const items = await new MockSupplier({ kind: 'hotel' }).search({
      kind: 'hotel', query: 'Faro', checkIn: '2026-09-12',
      checkOut: '2026-09-19', adults: 2, currency: 'EUR',
    })
    expect(items[0]!.detail.kind).toBe('hotel')
    if (items[0]!.detail.kind === 'hotel') expect(items[0]!.detail.nights).toBe(7)
  })

  it('rejects a search whose params.kind does not match the configured kind', async () => {
    const s = new MockSupplier({ kind: 'hotel' })
    await expect(s.search(search)).rejects.toThrow(/hotel.*flight|flight.*hotel/i)
  })

  it('rejects a quote whose params.kind does not match the configured kind', async () => {
    const hotelSearch: HotelSearch = {
      kind: 'hotel', query: 'Faro', checkIn: '2026-09-12',
      checkOut: '2026-09-19', adults: 2, currency: 'EUR',
    }
    const s = new MockSupplier({ kind: 'flight' })
    await expect(s.quote('MOCK-flight-x-0', hotelSearch))
      .rejects.toThrow(/hotel.*flight|flight.*hotel/i)
  })
})
