/** The version we write first: a price is a number and a currency code side by side. */
export type Price = { amount: number; currency: string }

export type Offer = {
  sourceId: string
  kind: 'flight' | 'hotel'
  name: string
  price: Price
  detail: string
}

export type FlightQuery = { from: string; to: string; departureDate: string; returnDate: string | null; adults: number; children: number }
export type HotelQuery = { city: string; checkIn: string; checkOut: string; adults: number; children: number }

/** FNV-1a over a string: the same query always lands on the same offers. */
function hash(input: string): number {
  let h = 0x811c9dc5
  for (const char of input) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * A stand-in for Kiwi and Google Hotels that never calls the network, so
 * tests and recordings see the same fares every time. Flights price in USD
 * and hotels in EUR on purpose: that mismatch is a bug we meet in module two.
 */
export class MockSupplier {
  constructor(private readonly seed = 1) {}

  searchFlights(query: FlightQuery): Offer[] {
    const base = hash(`${this.seed}:${query.from}:${query.to}:${query.departureDate}`)
    const carriers = ['TAP', 'Ryanair', 'easyJet']
    return carriers.map((carrier, i) => {
      const amount = 140 + ((base >>> (i * 5)) % 260)
      return {
        sourceId: `flight-${carrier.toLowerCase()}-${(base % 9000) + i}`,
        kind: 'flight',
        name: `${carrier} ${query.from} to ${query.to}`,
        price: { amount, currency: 'USD' },
        detail: `${i === 0 ? 'direct' : `${i} stop`}, departs ${query.departureDate} ${6 + i * 4}:${i === 1 ? '30' : '00'}, return ${query.returnDate ?? 'one way'}`,
      }
    })
  }

  searchHotels(query: HotelQuery): Offer[] {
    const base = hash(`${this.seed}:${query.city}:${query.checkIn}:${query.checkOut}`)
    const names = ['Praia Guesthouse', 'Hotel Atlantico', 'Quinta da Ria']
    return names.map((name, i) => {
      const perNight = 55 + ((base >>> (i * 6)) % 90)
      const nights = Math.max(1, Math.round((Date.parse(query.checkOut) - Date.parse(query.checkIn)) / 86_400_000))
      return {
        sourceId: `hotel-${i}-${base % 9000}`,
        kind: 'hotel',
        name: `${name}, ${query.city}`,
        price: { amount: perNight * nights, currency: 'EUR' },
        detail: `${nights} nights, ${i === 2 ? 'crib on request' : 'crib available'}, ${i === 0 ? '200 m' : `${(i + 1) * 900} m`} from the beach`,
      }
    })
  }
}
