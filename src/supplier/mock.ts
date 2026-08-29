import { formatMoney, money, type Money } from '../money.js'

export type Offer = {
  sourceId: string
  kind: 'flight' | 'hotel'
  name: string
  price: Money
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
 * A stand-in for Kiwi and Google Hotels that never calls the network, so tests
 * and recordings see the same fares every time. Flights price in USD and hotels
 * in EUR on purpose: that mismatch is the bug this lesson closes. Amounts are
 * whole units in the mock, so they are multiplied by 100 into minor units.
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
        price: money(amount * 100, 'USD'),
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
        price: money(perNight * nights * 100, 'EUR'),
        detail: `${nights} nights, ${i === 2 ? 'crib on request' : 'crib available'}, ${i === 0 ? '200 m' : `${(i + 1) * 900} m`} from the beach`,
      }
    })
  }
}

/**
 * What a tool result looks like on the wire. `Money` holds a bigint, and
 * JSON.stringify throws on those, which is a useful accident: it forces one
 * deliberate answer to "what does the model see?" instead of a silent one. The
 * model sees the formatted price and the exact minor units beside it.
 */
export function offerForModel(offer: Offer): Record<string, unknown> {
  return {
    ...offer,
    price: {
      minor: offer.price.minor.toString(),
      currency: offer.price.currency,
      formatted: formatMoney(offer.price),
    },
  }
}
