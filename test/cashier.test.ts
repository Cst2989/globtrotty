import { fitsBudget, totalOf } from '../src/cashier.js'
import { CurrencyMismatchError, money } from '../src/money.js'
import { MockSupplier } from '../src/supplier/mock.js'

const supplier = new MockSupplier()
const flight = supplier.searchFlights({
  from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: '2026-09-25', adults: 2, children: 1,
})[0]!
const hotel = supplier.searchHotels({
  city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1,
})[0]!

describe('the cashier', () => {
  it('refuses to add a USD flight to a EUR hotel', () => {
    expect(flight.price.currency).toBe('USD')
    expect(hotel.price.currency).toBe('EUR')
    expect(() => totalOf([flight, hotel])).toThrow(CurrencyMismatchError)
  })

  it('totals a same-currency trip', () => {
    const hotels = supplier.searchHotels({
      city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1,
    })
    const total = totalOf([hotels[0]!, hotels[1]!])
    expect(total.currency).toBe('EUR')
    expect(total.minor).toBe(hotels[0]!.price.minor + hotels[1]!.price.minor)
  })

  it('refuses to tell her a dollar total fits a euro budget', () => {
    expect(() => fitsBudget(money(140000n, 'USD'), money(150000n, 'EUR')))
      .toThrow(CurrencyMismatchError)
  })

  it('answers the budget question when both sides are euros', () => {
    expect(fitsBudget(money(140000n, 'EUR'), money(150000n, 'EUR'))).toBe(true)
    expect(fitsBudget(money(160000n, 'EUR'), money(150000n, 'EUR'))).toBe(false)
  })
})
