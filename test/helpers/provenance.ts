import { minorUnitExponent } from '../../src/money.js'

/**
 * Lesson 1.4's provenance check, in two functions, moved out of
 * test/provenance-v0.test.ts so that lesson 4.4's demonstration can run the
 * same check without importing a test file (which would register its cases
 * twice). Neither function changed on the way here, and neither will.
 *
 * RETIRED at lesson 4.5, which is the answer the README residual left open.
 * `checkCurrency` (src/gates/checks.ts) is what judges a currency now: it
 * compares codes, refuses rather than converts, and is the gate every real
 * proposal goes through. So this pair is no longer a check of anything this
 * system does. It is the reproduction of the check lesson 1.4 and the source
 * articles shipped, kept for the two files that exist to show what that check
 * waves through, and nothing new may call it.
 *
 * That is why `offeredAmounts` below stays currency-blind rather than learning
 * to compare currencies. Its blindness is PART OF THE DEFECT those two files
 * demonstrate: it reduces every price to a whole number and never looks at the
 * code beside it. Teaching it currencies would repair the exhibit and lose the
 * demonstration.
 */

/** Every amount in a reply that reads like money: "310 USD", "€420", "1,500 euros". */
export function quotedAmounts(text: string): number[] {
  const amounts: number[] = []
  for (const match of text.matchAll(/(?:€|\$|USD|EUR)\s?(\d[\d,]*)|(\d[\d,]*)\s?(?:€|\$|USD|EUR|euros|dollars)/gi)) {
    const raw = match[1] ?? match[2]
    if (raw) amounts.push(Number(raw.replace(/,/g, '')))
  }
  return amounts
}

type WireOffer = { price: { minor: string; currency: string } }

/** Every amount any tool result of this run offered, in whole units. */
export function offeredAmounts(trace: { content: string; isError: boolean }[]): Set<number> {
  const amounts = new Set<number>()
  for (const entry of trace) {
    if (entry.isError) continue
    for (const offer of JSON.parse(entry.content) as WireOffer[]) {
      // The reply quotes whole units, the wire carries minor units.
      amounts.add(Number(offer.price.minor) / 10 ** minorUnitExponent(offer.price.currency))
    }
  }
  return amounts
}
