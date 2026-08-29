import { compareMoney, sumMoney, type Money } from './money.js'
import type { Offer } from './supplier/mock.js'

/**
 * What her trip costs, from the offers we picked. There is no clever fallback
 * for a mixed list: `sumMoney` throws a CurrencyMismatchError, and the desk has
 * to choose offers in one currency or convert them on purpose. A total that
 * quietly picked a currency is the answer she would act on, which is why it must
 * not exist.
 */
export function totalOf(offers: Offer[]): Money {
  return sumMoney(offers.map((offer) => offer.price))
}

/** Whether a total fits a budget. Throws rather than compare two currencies. */
export function fitsBudget(total: Money, budget: Money): boolean {
  return compareMoney(total, budget) <= 0
}
