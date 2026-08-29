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
 * A mixed set fails even when NO item matches the expected currency, because
 * the totals gate downstream cannot sum two currencies either.
 *
 * Exported for reuse: the totals gate (Task 10) sums these same items and
 * would otherwise have to re-detect mixed currencies itself to avoid calling
 * `sumMoney` on incompatible `Money` values. Call this first instead of
 * duplicating the currency check.
 */
export function checkCurrency(items: RehydratedItem[], expected: string): Violation[] {
  const bad = items.filter(({ item }) => item.price.currency !== expected)
  if (bad.length === 0) return []
  const seen = [...new Set(items.map((i) => i.item.price.currency))]
  return [{
    gate: 'currency',
    sourceIds: bad.map((b) => b.item.sourceId),
    detail: `This trip is priced in ${expected}, but these items are not: `
          + `${bad.map((b) => `${b.item.sourceId} (${b.item.price.currency})`).join(', ')}. `
          + `Search again with currency=${expected}. `
          + `Currencies present: ${seen.join(', ')}.`,
  }]
}
