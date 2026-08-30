import { compareMoney, sumMoney, type Money } from './money.js'
import type { SupplierItem } from './supplier/types.js'

/**
 * What her trip costs, from the items we picked. There is no clever fallback
 * for a mixed list: `sumMoney` throws a CurrencyMismatchError, and the desk has
 * to choose items in one currency or convert them on purpose. A total that
 * quietly picked a currency is the answer she would act on, which is why it must
 * not exist.
 *
 * This is the whole cashier at lesson 4.1, and it is only ever handed items a
 * caller already chose. Lesson 4.5's `checkTotals` is what recomputes a total
 * from the corpus rather than trusting one, and lesson 4.6 is where this file
 * grows the part that re-quotes before she is given a link.
 */
export function totalOf(items: SupplierItem[]): Money {
  return sumMoney(items.map((item) => item.price))
}

/** Whether a total fits a budget. Throws rather than compare two currencies. */
export function fitsBudget(total: Money, budget: Money): boolean {
  return compareMoney(total, budget) <= 0
}
