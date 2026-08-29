import type { RehydratedItem, Violation } from './types.js'

/**
 * `now` is injected, never read from the clock inside. Two reasons: a test
 * would otherwise have to sleep past a TTL, and slice 2's replay has to be able
 * to re-judge a recorded conversation at the instant it originally ran.
 *
 * An item stamped in the FUTURE fails too. That is not pedantry — a future
 * `fetched_at` means a clock disagreement somewhere, and the one thing we must
 * not do with a timestamp we cannot trust is treat it as reassuring.
 */
export function checkFreshness(items: RehydratedItem[], now: Date): Violation[] {
  const bad = items.filter(({ item }) => {
    const age = now.getTime() - item.fetchedAt.getTime()
    // A corrupt/unparseable `fetchedAt` makes `getTime()` NaN, and NaN fails
    // both `< 0` and `> ttl`, so an ordinary bounds check would silently
    // classify it as fresh. A timestamp we cannot trust is never evidence of
    // freshness, so treat NaN as stale explicitly.
    if (Number.isNaN(age)) return true
    return age < 0 || age > item.ttlSeconds * 1000
  })
  if (bad.length === 0) return []
  return [{
    gate: 'freshness',
    sourceIds: bad.map((b) => b.item.sourceId),
    detail: `These prices are older than we will quote: `
          + `${bad.map((b) => b.item.sourceId).join(', ')}. Re-search them and propose the new ids.`,
  }]
}

/**
 * Refuses; never converts. There is no FX rate in this codebase, deliberately —
 * a converted price is a price we made up, and the whole point of the gate
 * stack is that every number the user sees came from a supplier.
 *
 * `expected` is `string | null` because the only source of a trip currency is
 * `budget.value.currency`, which is `null` until a budget is set. That is not
 * an excuse to skip the check:
 *
 *  - `expected` given: every item must match it. A mixed set fails even when
 *    NO item matches `expected`, because the totals gate downstream cannot
 *    sum two currencies either — this branch also catches "all items agree
 *    with each other but not with the trip currency."
 *  - `expected === null`: there is no trip currency to compare against yet,
 *    so this enforces internal consistency only — every item must at least
 *    agree with every OTHER item, because summing them would still be
 *    impossible even with no target to name.
 *
 * Exported for reuse: the totals gate (Task 10) sums these same items and
 * would otherwise have to re-detect mixed currencies itself to avoid calling
 * `sumMoney` on incompatible `Money` values. Call this first (passing the
 * notebook's budget currency, or `null` if unset) instead of duplicating the
 * currency check.
 */
export function checkCurrency(items: RehydratedItem[], expected: string | null): Violation[] {
  if (items.length === 0) return []
  const currencies = [...new Set(items.map((i) => i.item.price.currency))]

  if (expected !== null) {
    const exp = expected.toUpperCase() // money() upper-cases currency codes; compare on the same footing
    const bad = items.filter(({ item }) => item.price.currency !== exp)
    if (bad.length === 0) return []
    return [{
      gate: 'currency',
      sourceIds: bad.map((b) => b.item.sourceId),
      detail: `This trip is priced in ${exp}, but these items are not: `
            + `${bad.map((b) => `${b.item.sourceId} (${b.item.price.currency})`).join(', ')}. `
            + `Search again with currency=${exp}. `
            + `Currencies present: ${currencies.join(', ')}.`,
    }]
  }

  if (currencies.length <= 1) return []
  return [{
    gate: 'currency',
    sourceIds: items.map((i) => i.item.sourceId),
    detail: `No trip currency is set yet, but these items mix currencies and cannot be summed: `
          + `${items.map((i) => `${i.item.sourceId} (${i.item.price.currency})`).join(', ')}. `
          + `Currencies present: ${currencies.join(', ')}. Pick one currency and re-search the rest.`,
  }]
}
