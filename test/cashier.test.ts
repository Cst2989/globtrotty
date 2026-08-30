import { fitsBudget, totalOf } from '../src/cashier.js'
import { CurrencyMismatchError, money } from '../src/money.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch, HotelSearch } from '../src/supplier/types.js'

const flightSearch: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: '2026-09-25',
  flexDays: 0, adults: 2, children: 1, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const hotelSearch: HotelSearch = {
  kind: 'hotel', query: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25',
  adults: 2, currency: 'EUR',
}

describe('the cashier', () => {
  it('refuses to add a USD flight to a EUR hotel', async () => {
    // Built on purpose: a supplier configured to answer in a currency the
    // search did not ask for is exactly the fault lesson 4.5's currency gate
    // catches, and here it is the fault this function refuses to hide.
    const wrong = mockSuppliers({ flight: { currency: 'USD' } })
    const [flight] = await wrong.flight.search(flightSearch)
    const [hotel] = await wrong.hotel.search(hotelSearch)
    expect(flight!.price.currency).toBe('USD')
    expect(hotel!.price.currency).toBe('EUR')
    expect(() => totalOf([flight!, hotel!])).toThrow(CurrencyMismatchError)
  })

  it('totals a same-currency trip', async () => {
    const pair = mockSuppliers()
    const [flight] = await pair.flight.search(flightSearch)
    const [hotel] = await pair.hotel.search(hotelSearch)
    const total = totalOf([flight!, hotel!])
    expect(total.currency).toBe('EUR')
    expect(total.minor).toBe(flight!.price.minor + hotel!.price.minor)
  })

  it('refuses to tell her a dollar total fits a euro budget', () => {
    expect(() => fitsBudget(money(140000n, 'USD'), money(150000n, 'EUR')))
      .toThrow(CurrencyMismatchError)
  })

  it('answers the budget question when both sides are euros', () => {
    expect(fitsBudget(money(140000n, 'EUR'), money(150000n, 'EUR'))).toBe(true)
    expect(fitsBudget(money(160000n, 'EUR'), money(150000n, 'EUR'))).toBe(false)
  })

  it('refuses an empty list rather than inventing a currency for zero', () => {
    expect(() => totalOf([])).toThrow(/empty/i)
  })
})
