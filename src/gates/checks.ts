import { compareMoney, formatMoney, sumMoney, type Money } from '../money.js'
import { isFlight, isHotel, itemTotal, type SupplierKind } from '../supplier/types.js'
import { SLOT_KINDS } from './types.js'
import type { RehydratedItem, Violation } from './types.js'

/**
 * `now` is injected, never read from the clock inside. Two reasons: a test
 * would otherwise have to sleep past a TTL, and module 6's replay has to be
 * able to re-judge a recorded conversation at the instant it originally ran.
 *
 * An item stamped in the FUTURE fails too. That is not pedantry: a future
 * `fetchedAt` means a clock disagreement somewhere, and the one thing not to do
 * with a timestamp we cannot trust is treat it as reassuring.
 */
export function checkFreshness(items: RehydratedItem[], now: Date): Violation[] {
  const bad = items.filter(({ item }) => {
    const age = now.getTime() - item.fetchedAt.getTime()
    // A corrupt or unparseable `fetchedAt` makes getTime() NaN, and NaN fails
    // both `< 0` and `> ttl`, so an ordinary bounds check silently classifies it
    // as fresh. A timestamp we cannot trust is never evidence of freshness.
    if (Number.isNaN(age)) return true
    return age < 0 || age > item.ttlSeconds * 1000
  })
  if (bad.length === 0) return []
  return [{
    gate: 'freshness',
    sourceIds: bad.map((b) => b.item.sourceId),
    detail: 'These prices are older than we will quote: '
          + `${bad.map((b) => b.item.sourceId).join(', ')}. Re-search them and propose the new ids.`,
  }]
}

/**
 * Refuses; never converts. There is no FX rate in this codebase, deliberately: a
 * converted price is a price we made up, and the whole point of the gate stack
 * is that every number she sees came from a supplier.
 *
 * `expected` is `string | null` because the only source of a trip currency is
 * `budget.value.currency`, which is null until she names a budget. That is not
 * an excuse to skip the check:
 *
 *  - `expected` given: every item must match it. A mixed set fails even when NO
 *    item matches `expected`, because the totals gate downstream cannot sum two
 *    currencies either, so this branch also catches "all items agree with each
 *    other but not with the trip currency".
 *  - `expected === null`: there is no trip currency to compare against yet, so
 *    this enforces internal consistency only. Every item must at least agree
 *    with every OTHER item, because summing them would still be impossible with
 *    no target to name.
 *
 * Exported for reuse: `checkTotals` below sums these same items and would
 * otherwise have to re-detect mixed currencies itself to avoid calling
 * `sumMoney` on incompatible values.
 */
export function checkCurrency(items: RehydratedItem[], expected: string | null): Violation[] {
  if (items.length === 0) return []
  const currencies = [...new Set(items.map((i) => i.item.price.currency))]

  if (expected !== null) {
    // money() upper-cases currency codes, so compare on the same footing.
    const exp = expected.toUpperCase()
    const bad = items.filter(({ item }) => item.price.currency !== exp)
    if (bad.length === 0) return []
    return [{
      gate: 'currency',
      sourceIds: bad.map((b) => b.item.sourceId),
      detail: `This trip is priced in ${exp}, but these items are not: `
            + `${bad.map((b) => `${b.item.sourceId} (${b.item.price.currency})`).join(', ')}. `
            + `Search again with currency=${exp}. Currencies present: ${currencies.join(', ')}.`,
    }]
  }

  if (currencies.length <= 1) return []
  return [{
    gate: 'currency',
    sourceIds: items.map((i) => i.item.sourceId),
    detail: 'No trip currency is set yet, but these items mix currencies and cannot be summed: '
          + `${items.map((i) => `${i.item.sourceId} (${i.item.price.currency})`).join(', ')}. `
          + `Currencies present: ${currencies.join(', ')}. Pick one currency and re-search the rest.`,
  }]
}

/**
 * Name validity and kind compatibility, and deliberately nothing more. It does
 * NOT verify that the set of slots is complete, that 'outbound' and 'flight'
 * are not both used, or that 'inbound' is present when a return was asked for.
 * Those are itinerary-shape rules, they need the notebook, and they belong to
 * the reviewer seat in module 5.
 *
 * `ItemRef.slot` is a plain `string` and this function is exported, so a caller
 * that reached it without going through `ProposalRefsSchema` is still checked.
 * Without this gate, every slot name in the system is an unchecked literal and
 * a hotel proposed for the outbound leg sails through every other check.
 */
export function checkSlots(items: RehydratedItem[]): Violation[] {
  const unknown: RehydratedItem[] = []
  const mismatched: { r: RehydratedItem; wants: SupplierKind }[] = []

  for (const r of items) {
    // `Object.hasOwn`, never a bare index. `slot` is model-controlled, so
    // 'toString', 'constructor' and '__proto__' would otherwise resolve through
    // Object.prototype, return something truthy, skip the unknown-name branch,
    // and render a message about a native function. That still fails closed,
    // and it misclassifies an unknown-NAME fault as a wrong-KIND one and hands
    // the model something it cannot act on.
    if (!Object.hasOwn(SLOT_KINDS, r.ref.slot)) {
      unknown.push(r)
      continue
    }
    const wants: SupplierKind = SLOT_KINDS[r.ref.slot as keyof typeof SLOT_KINDS]

    // `detail.kind`, not the sibling `item.kind`. SupplierItem does not couple
    // the two, and the corpus round trip reads `detail` back as unvalidated
    // jsonb, so a row where they disagree is possible. `checkDates` already
    // keys off detail.kind through isFlight/isHotel; keying this gate off the
    // other field would let one inconsistent row be slot-checked as a flight
    // and date-checked as a hotel. Recompute, never trust.
    if (r.item.detail.kind !== wants) mismatched.push({ r, wants })
  }

  // Two distinct faults, so two violations, and each one groups every offender,
  // so the model gets one round trip per fault rather than per item.
  const violations: Violation[] = []
  if (unknown.length > 0) {
    violations.push({
      gate: 'slots',
      sourceIds: unknown.map((r) => r.item.sourceId),
      detail: 'These items were proposed for a slot that does not exist: '
            + `${unknown.map((r) => `${r.item.sourceId} (slot "${r.ref.slot}")`).join(', ')}. `
            + `The only slots are: ${Object.keys(SLOT_KINDS).join(', ')}.`,
    })
  }
  if (mismatched.length > 0) {
    violations.push({
      gate: 'slots',
      sourceIds: mismatched.map(({ r }) => r.item.sourceId),
      detail: 'These items do not match the slot they were proposed for: '
            + `${mismatched.map(({ r, wants }) =>
                  `${r.item.sourceId} is a ${r.item.detail.kind} but slot "${r.ref.slot}" takes a ${wants}`
                ).join('; ')}.`,
    })
  }
  return violations
}

export type DateWindow = { earliest: string; latest: string }
export type TotalsResult = { violations: Violation[]; total: Money | null }

/**
 * The ONLY producer of a trip total. Recomputes from price times quantity
 * rather than trusting the `lineTotal` it was handed, so a caller that mutated
 * one cannot move the total.
 *
 * Mixed price bases are refused rather than summed. Adding a pre-tax hotel to
 * an all-in flight yields a number that is neither, and quoting it is precisely
 * the confidently-wrong-total failure the gate stack exists to prevent.
 *
 * Currency is NOT re-detected here. `checkCurrency` owns that question and is
 * exported for exactly this reuse; re-implementing it would mean one
 * mixed-currency proposal came back described twice, in two different
 * sentences, from two gates. `expected` is required rather than defaulted so a
 * caller has to decide: a silently defaulted null is how "we forgot to pass the
 * trip currency" turns into "the trip currency was never checked".
 *
 * ## Recording the outcome, the rule, stated once
 *
 * **When `total === null`, BOTH the `totals` gate AND the `budget` gate are not
 * evaluated. Never a pass. The discriminator is `total`, NOT the violation
 * list.**
 *
 * The violation list does not partition by gate the way a writer bucketing rows
 * would assume. A mixed-currency proposal returns `{violations: [<currency>],
 * total: null}`: zero violations tagged `totals`, and `checkBudget` returns []
 * because there is no number to compare. A writer reading "no violations with
 * my gate name" as "my gate passed" records `currency: fail, totals: pass,
 * budget: pass`, which asserts that a trip total was computed and checked when
 * none exists, from the one gate whose entire job was to refuse to compute it.
 *
 * Returns violations; never throws. The three throwing calls underneath are all
 * guarded: `sumMoney` throws on an empty array, and the `items.length === 0`
 * early return is the guard; `addMoney` inside it throws on a currency
 * mismatch, and a clean `checkCurrency` result is the guard, since with
 * `expected` set every item equals it and with `expected` null there is at most
 * one distinct currency; `itemTotal` throws on a quantity that is not a
 * positive integer, so quantities are turned into a violation first.
 *
 * ## `quantity` must be 1
 *
 * `quantity` is the last model-controlled number that still moves the total, so
 * it is checked here rather than trusted. The reasoning is at the check itself
 * below.
 */
export function checkTotals(items: RehydratedItem[], expected: string | null): TotalsResult {
  if (items.length === 0) return { violations: [], total: null }

  const violations: Violation[] = [...checkCurrency(items, expected)]

  // Every item is named, not a subset: with two bases present there is no
  // single odd one out, and picking the minority would tell the model to
  // re-search the wrong half. Same reasoning as checkCurrency's null branch.
  const bases = [...new Set(items.map((i) => i.item.priceBasis))]
  if (bases.length > 1) {
    violations.push({
      gate: 'totals',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `These items mix all-in and pre-tax prices (${bases.join(', ')}), so they cannot be `
            + 'summed into one total. Re-search so every item quotes the same basis.',
    })
  }

  // itemTotal throws on a non-positive or fractional quantity, and a gate that
  // throws is a gate that takes the whole turn down. The tool schema already
  // bounds quantity, and this function is exported and callable without it, so
  // the bound is re-checked here rather than assumed.
  const badQuantity = items.filter((i) => !Number.isSafeInteger(i.ref.quantity) || i.ref.quantity <= 0)
  if (badQuantity.length > 0) {
    violations.push({
      gate: 'totals',
      sourceIds: badQuantity.map((i) => i.item.sourceId),
      detail: 'These items have a quantity that is not a whole positive number: '
            + `${badQuantity.map((i) => `${i.item.sourceId} (${i.ref.quantity})`).join(', ')}. `
            + 'Quantity counts identical units, so it cannot be fractional or zero.',
    })
  }

  // ## The quantity hole, and why the only legal quantity is 1
  //
  // `quantity` is the one number in a proposal the MODEL still controls, and the
  // check above only bounded its shape. The total is the sum of corpus price
  // times quantity, so a model that sends `quantity: 16` gets a sixteen times
  // trip total back, computed by the server, from real corpus prices, with
  // `gate_results` recording `totals: pass`. That is the single hole in this
  // module's headline guarantee that no price the model wrote reaches her: it
  // never wrote a price, it wrote a multiplier, and the effect on the number
  // she sees is the same.
  //
  // What closes it is that for every supplier this branch ships, the corpus
  // price already covers the whole thing. Verified against the captured
  // fixtures rather than assumed:
  //
  //  - Kiwi searches 2 adults and returns `price: 464`, which is 464 EUR for
  //    the party and not per seat. Multiplying by the passenger count
  //    double-counts them.
  //  - SearchApi reads `total_price`, the whole stay. HotelDetail.nights is
  //    derived from the requested window and is descriptive, never a
  //    multiplier.
  //  - MockSupplier mirrors both, one price per item.
  //
  // So 1 is the only correct quantity anything in this branch can produce, and
  // anything else is a fault worth telling the model about rather than silently
  // multiplying. A GENUINE per-unit supplier, one whose corpus price is per
  // seat or per night, must relax this DELIBERATELY, and the right shape for
  // that is a field on SupplierItem saying what the price covers, set by each
  // adapter and read here, so the answer travels with the item instead of being
  // a global assumption. That field is not added today because every supplier
  // in this branch would set the same value, which carries no information and
  // buys an unexercised code path plus a live schema column. Add it with the
  // adapter that needs it.
  //
  // Filed as a `totals` violation, never thrown: this is model-controlled input
  // reaching a gate, and a gate returns violations.
  const multiplied = items.filter((i) => Number.isSafeInteger(i.ref.quantity) && i.ref.quantity > 1)
  if (multiplied.length > 0) {
    violations.push({
      gate: 'totals',
      sourceIds: multiplied.map((i) => i.item.sourceId),
      detail: 'These items were proposed with a quantity above 1: '
            + `${multiplied.map((i) => `${i.item.sourceId} (${i.ref.quantity})`).join(', ')}. `
            + 'Every price in this system already covers the whole booking, a flight price covers '
            + 'the whole party and a hotel price covers the whole stay, so quantity must be 1. '
            + 'Propose each item once with quantity 1.',
    })
  }

  if (violations.length > 0) return { violations, total: null }
  return { violations: [], total: sumMoney(items.map((i) => itemTotal(i.item, i.ref.quantity))) }
}

/**
 * Takes the total `checkTotals` already computed instead of recomputing it. Two
 * reasons, and neither is performance: a second sum is a second chance to
 * disagree with the first, and a budget gate that re-ran the totals gate would
 * report every totals fault a second time in its own words.
 *
 * So when there is no trustworthy total this returns NOTHING rather than a
 * second violation. That is a deliberate generalisation and worth naming as
 * one: the requirement was that a mixed-currency proposal yield a single
 * violation, and this suppresses for every cause of a null total, mixed
 * currencies, mixed bases and a bad quantity alike. It generalises because the
 * causes are indistinguishable in the only respect budget cares about, which is
 * that there is no number to compare. `total === null` only happens when
 * `checkTotals` itself filed a violation, or the set was empty, so the proposal
 * is already rejected and restating the same fault under a different gate name
 * is the noise this stack exists to avoid.
 *
 * It is not failing open. Budget never invents a total and never returns [] for
 * a proposal that HAD a total and exceeded it. See `checkTotals` for the
 * recording rule: a [] from here means pass ONLY when `totals.total` is
 * non-null, and otherwise it means not evaluated.
 *
 * `items` is here only to name the offenders; the number under test comes from
 * `totals`. Note what that does not buy: `TotalsResult` is a structural type,
 * so a hand-built `{violations: [], total: money(999n,'EUR')}` typechecks and
 * nothing ties `totals` to `items`. Passing the `TotalsResult` computed from
 * THESE items is the caller's responsibility; the signature makes it the
 * obvious thing to do, not the only possible thing.
 *
 * Never throws. `compareMoney` throws on a currency mismatch, and the explicit
 * currency comparison immediately above it is the guard: the mismatch is
 * reported as a violation rather than raised, because we refuse and never
 * convert.
 */
export function checkBudget(
  items: RehydratedItem[],
  totals: TotalsResult,
  budget: Money | null,
): Violation[] {
  if (!budget || !totals.total) return []
  const total = totals.total

  if (total.currency !== budget.currency) {
    return [{
      gate: 'budget',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `The budget is set in ${budget.currency} but this trip totals in ${total.currency}. `
            + `We do not convert; search in ${budget.currency}.`,
    }]
  }
  if (compareMoney(total, budget) > 0) {
    return [{
      gate: 'budget',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `This trip totals ${formatMoney(total)}, over the ${formatMoney(budget)} budget.`,
    }]
  }
  return []
}

/**
 * Compares DATE PREFIXES as strings. Kiwi returns naive local ISO with no
 * offset ("2026-09-12T16:40:00"), and `new Date()` on one of those applies the
 * server's timezone and can roll a 23:59 departure into the next day, failing a
 * window her own calendar says is fine. Lexicographic comparison of yyyy-mm-dd
 * is exactly date ordering, so no parsing is needed at all.
 *
 * The suite pins TZ=America/Los_Angeles (vitest.config.ts) precisely so that
 * stays true under review: under TZ=UTC the offset is zero and a `new Date(...)`
 * implementation passes every one of these tests.
 *
 * Flights are windowed on their DEPARTURE dates only. An overnight leg that
 * departs on the last day of the window and lands the next morning is a normal
 * return, not a violation, and windowing arrivals too would reject it. Hotels
 * are windowed on both ends, because a stay is bounded by both.
 */
export function checkDates(items: RehydratedItem[], window: DateWindow | null): Violation[] {
  if (!window) return []
  const offenders: string[] = []
  for (const { item } of items) {
    const dates: string[] = []
    if (isFlight(item)) {
      dates.push(day(item.detail.outbound.departureLocal))
      if (item.detail.inbound) dates.push(day(item.detail.inbound.departureLocal))
    } else if (isHotel(item)) {
      dates.push(day(item.detail.checkIn), day(item.detail.checkOut))
    }
    if (dates.some((d) => d < window.earliest || d > window.latest)) offenders.push(item.sourceId)
  }
  if (offenders.length === 0) return []
  return [{
    gate: 'dates',
    sourceIds: offenders,
    detail: `These items fall outside the ${window.earliest} to ${window.latest} travel window: `
          + `${offenders.join(', ')}.`,
  }]
}

/** First ten characters of an ISO timestamp: the date, with no parsing and no zone. */
function day(iso: string): string {
  return iso.slice(0, 10)
}
