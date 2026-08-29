import { MockSupplier } from '../src/supplier/mock.js'

describe('MockSupplier', () => {
  const supplier = new MockSupplier()
  const query = { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: '2026-09-25', adults: 2, children: 1 }
  it('returns the same three flights for the same query', () => {
    expect(supplier.searchFlights(query)).toEqual(supplier.searchFlights(query))
    expect(supplier.searchFlights(query)).toHaveLength(3)
  })
  it('changes the fares when the date changes', () => {
    const other = supplier.searchFlights({ ...query, departureDate: '2026-09-19' })
    expect(other.map((o) => o.price.minor)).not.toEqual(supplier.searchFlights(query).map((o) => o.price.minor))
  })
  it('prices hotels per night in euros', () => {
    const hotels = supplier.searchHotels({ city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
    expect(hotels.every((h) => h.price.currency === 'EUR')).toBe(true)
    expect(hotels[0]!.price.minor % 100n).toBe(0n)     // whole euros in the mock
    expect(hotels[0]?.detail).toContain('7 nights')
  })
})
