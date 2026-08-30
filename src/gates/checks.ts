import { compareMoney, formatMoney, sumMoney, type Money } from '../money.js'
import { isFlight, isHotel, itemTotal, type SupplierKind } from '../supplier/types.js'
import { sanitizeSourceId } from '../sanitize.js'
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
          + `${bad.map((b) => sanitizeSourceId(b.item.sourceId)).join(', ')}. Re-search them and propose the new ids.`,
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
            + `${bad.map((b) => `${sanitizeSourceId(b.item.sourceId)} (${b.item.price.currency})`).join(', ')}. `
            + `Search again with currency=${exp}. `
            + `Currencies present: ${currencies.join(', ')}.`,
    }]
  }

  if (currencies.length <= 1) return []
  return [{
    gate: 'currency',
    sourceIds: items.map((i) => i.item.sourceId),
    detail: `No trip currency is set yet, but these items mix currencies and cannot be summed: `
          + `${items.map((i) => `${sanitizeSourceId(i.item.sourceId)} (${i.item.price.currency})`).join(', ')}. `
          + `Currencies present: ${currencies.join(', ')}. Pick one currency and re-search the rest.`,
  }]
}

/**
 * The slot vocabulary, in ONE place, and the source `ProposalRefsSchema`
 * derives its `slot` enum from — so the set the tool publishes to the model and
 * the set this gate enforces cannot drift apart. `ItemRef.slot` stays typed as
 * a plain `string`, because this function is exported and a caller that reached
 * it without going through the schema must still be checked; without this every
 * slot name in the system is an unchecked literal and a hotel proposed for the
 * 'outbound' leg sails through every other gate.
 *
 * The names come from what the codebase already models, not from invention:
 * `SupplierKind` is 'flight' | 'hotel', and `FlightDetail` carries `outbound`
 * and `inbound` legs. So:
 *
 *  - 'outbound' / 'inbound' — a one-way item standing for a single leg, named
 *    after the two legs `FlightDetail` already names.
 *  - 'flight' — one item covering the whole journey. Kiwi returns a return
 *    trip as a SINGLE `SupplierItem` whose `detail` holds both legs, so there
 *    has to be a slot for "the flights" as one line.
 *  - 'stay' — the hotel.
 *
 * The check is deliberately only name-validity and kind-compatibility. It does
 * NOT verify that the set of slots is complete, that 'outbound' and 'flight'
 * are not both used, or that 'inbound' is present when a return was requested.
 * Those are itinerary-shape rules; they need the notebook, and they belong to a
 * later plan. Matching is exact and case-sensitive: the vocabulary is a closed
 * set the tool description publishes, and quietly accepting 'Outbound' would
 * make the published set a lie.
 */
export const SLOT_KINDS = {
  outbound: 'flight',
  inbound:  'flight',
  flight:   'flight',
  stay:     'hotel',
} as const satisfies Record<string, SupplierKind>

/** Implements the spec's `mismatched(items, offer)` pre-gate (§5). */
export function checkSlots(items: RehydratedItem[]): Violation[] {
  const unknown: RehydratedItem[] = []
  const mismatched: { r: RehydratedItem; wants: SupplierKind }[] = []

  for (const r of items) {
    // `Object.hasOwn`, never a bare index. `slot` is model-controlled and this
    // function is reachable without the tool schema's enum, so `slot: 'toString'`,
    // 'constructor' or '__proto__' would otherwise resolve through
    // `Object.prototype`, return
    // something truthy, skip the unknown-name branch, and render
    // `slot "toString" takes a function toString() { [native code] }`. That
    // still fails closed, but it misclassifies an unknown-NAME fault as a
    // wrong-KIND one and hands the model a message it cannot act on.
    if (!Object.hasOwn(SLOT_KINDS, r.ref.slot)) {
      unknown.push(r)
      continue
    }
    const wants: SupplierKind = SLOT_KINDS[r.ref.slot as keyof typeof SLOT_KINDS]

    // `detail.kind`, not the sibling `item.kind`. `SupplierItem` does not couple
    // the two fields, and the corpus round-trip reads `detail` back as
    // unvalidated JSON, so a row where they disagree is possible. `checkDates`
    // already keys off `detail.kind` through `isFlight`/`isHotel`; keying this
    // gate off the other field would let one inconsistent row be slot-checked
    // as a flight and date-checked as a hotel. Recompute, never trust.
    if (r.item.detail.kind !== wants) mismatched.push({ r, wants })
  }

  // Two distinct faults, so two violations — but each one groups every
  // offender, so the model gets one round trip per fault rather than per item.
  const violations: Violation[] = []
  if (unknown.length > 0) {
    violations.push({
      gate: 'slots',
      sourceIds: unknown.map((r) => r.item.sourceId),
      detail: `These items were proposed for a slot that does not exist: `
            + `${unknown.map((r) => `${sanitizeSourceId(r.item.sourceId)} (slot "${r.ref.slot}")`).join(', ')}. `
            + `The only slots are: ${Object.keys(SLOT_KINDS).join(', ')}.`,
    })
  }
  if (mismatched.length > 0) {
    violations.push({
      gate: 'slots',
      sourceIds: mismatched.map(({ r }) => r.item.sourceId),
      // `r.item.detail.kind` is sanitized too, not just `sourceId`: it is read
      // back from `payload` jsonb with no runtime validation (the type system
      // says 'flight' | 'hotel', but nothing enforces that at the storage
      // boundary), so a malformed or manually-seeded row could in principle
      // carry an arbitrary string here — the same "unvalidated corpus content
      // reaching model-read text" shape as `sourceId`, just on a different
      // field of the same untrusted row.
      detail: `These items do not match the slot they were proposed for: `
            + `${mismatched.map(({ r, wants }) =>
                  `${sanitizeSourceId(r.item.sourceId)} is a ${sanitizeSourceId(r.item.detail.kind)} but slot `
                + `"${r.ref.slot}" takes a ${wants}`).join('; ')}.`,
    })
  }
  return violations
}

export type DateWindow = { earliest: string; latest: string }
export type TotalsResult = { violations: Violation[]; total: Money | null }

/**
 * The ONLY producer of a trip total. Recomputes from `price × quantity` rather
 * than trusting the `lineTotal` it was handed, so a caller that mutated one
 * cannot move the total.
 *
 * Mixed price bases are refused rather than summed. Adding a pre-tax hotel to
 * an all-in flight yields a number that is neither, and quoting it is precisely
 * the confidently-wrong-total failure the gate stack exists to prevent.
 *
 * Currency is NOT re-detected here. `checkCurrency` above already owns that
 * question and is exported for exactly this reuse; re-implementing it would
 * mean one mixed-currency proposal came back described twice, in two different
 * sentences, from two gates. Pass the notebook's budget currency as `expected`,
 * or `null` when no budget is set yet — `null` still enforces that the items
 * agree with EACH OTHER, which is the precondition `sumMoney` needs.
 *
 * `expected` is required rather than defaulted so a caller has to decide. A
 * silently-defaulted `null` is how "we forgot to pass the trip currency" turns
 * into "the trip currency was never checked".
 *
 * ## RECORDING THE OUTCOME — the rule, stated once
 *
 * **When `total === null`, BOTH the `totals` gate AND the `budget` gate are
 * `not_evaluated`. Never `pass`. The discriminator is `total`, NOT the
 * violation list.**
 *
 * This matters because the violation list does not partition by gate the way a
 * writer bucketing rows by `Violation.gate` would assume. A mixed-currency
 * proposal returns `{violations: [<currency>], total: null}` — ZERO violations
 * tagged `totals`, and `checkBudget` returns `[]`. A writer that reads "no
 * violations with my gate name" as "my gate passed" records
 * `currency: fail, totals: pass, budget: pass`. That audit record asserts a
 * trip total was computed and checked when none exists, from the one gate whose
 * entire job was to refuse to compute it.
 *
 * Returns violations; never throws. The two throwing calls it could make are
 * guarded:
 *  - `sumMoney` throws on an empty array — the `items.length === 0` early
 *    return above is the guard, and nothing between them can empty the list.
 *  - `addMoney` (inside `sumMoney`) throws on a currency mismatch — a clean
 *    `checkCurrency` result is the guard: with `expected` set every item equals
 *    it, and with `expected` null there is at most one distinct currency. Both
 *    branches leave the set uniform.
 *  - `itemTotal` throws on a quantity that is not a positive integer, so
 *    quantities are validated into a violation first.
 *
 * ## `quantity` must be 1
 *
 * `quantity` is the last model-controlled number that still moves the total, so
 * it is checked here rather than trusted. Every supplier this repository ships
 * quotes the WHOLE booking — Kiwi's price is the party total, SearchApi's is
 * the whole stay — which makes 1 the only correct multiplier and anything else
 * a `totals` violation. The reasoning, the fixture evidence, and what a real
 * per-unit supplier would have to do instead are all at the check itself below.
 */
export function checkTotals(items: RehydratedItem[], expected: string | null): TotalsResult {
  if (items.length === 0) return { violations: [], total: null }

  const violations: Violation[] = [...checkCurrency(items, expected)]

  // Every item is named, not a subset: with two bases present there is no
  // single odd one out, and picking the minority would tell the model to
  // re-search the wrong half. Same reasoning as `checkCurrency`'s null branch.
  const bases = [...new Set(items.map((i) => i.item.priceBasis))]
  if (bases.length > 1) {
    violations.push({
      gate: 'totals',
      sourceIds: items.map((i) => i.item.sourceId),
      detail: `These items mix all-in and pre-tax prices (${bases.join(', ')}), so they `
            + `cannot be summed into one total. Re-search so every item quotes the same basis.`,
    })
  }

  // `itemTotal` throws on a non-positive or fractional quantity, and a gate
  // that throws is a gate that takes the whole turn down. The tool schema
  // already bounds quantity, but this function is exported and callable
  // without it, so the bound is re-checked here rather than assumed.
  const badQuantity = items.filter(
    (i) => !Number.isSafeInteger(i.ref.quantity) || i.ref.quantity <= 0,
  )
  if (badQuantity.length > 0) {
    violations.push({
      gate: 'totals',
      sourceIds: badQuantity.map((i) => i.item.sourceId),
      detail: `These items have a quantity that is not a whole positive number: `
            + `${badQuantity.map((i) => `${sanitizeSourceId(i.item.sourceId)} (${i.ref.quantity})`).join(', ')}. `
            + `Quantity counts identical units, so it cannot be fractional or zero.`,
    })
  }

  // ## The quantity hole, and why the only legal quantity is 1
  //
  // `quantity` is the one number in a proposal the MODEL still controls, and
  // the line above only bounded its shape. `total = Σ(corpus_price × quantity)`
  // — so a model that sends `quantity: 16` gets a 16× trip total back, computed
  // by the server, from real corpus prices, with `gate_results` recording
  // `totals: pass`. That is the single hole in this branch's headline guarantee
  // that no price the model writes reaches the user: it never wrote a price,
  // it wrote a multiplier, and the effect on the number the user sees is the
  // same.
  //
  // What closes it is that for every supplier this repository ships, the
  // corpus price ALREADY covers the whole thing. Verified against the captured
  // fixtures, not assumed:
  //
  //  - Kiwi searches `2 adults` and returns `price: 464` — €464 for the party,
  //    not per seat. Multiplying by the passenger count double-counts them.
  //  - SearchApi reads `total_price`, the whole stay. `HotelDetail.nights` is
  //    derived from the requested window and is descriptive, never a
  //    multiplier.
  //  - MockSupplier mirrors both, one price per item.
  //
  // So `1` is the only correct quantity anything in this branch can produce,
  // and anything else is a fault worth telling the model about rather than
  // silently multiplying. §5's "3 seats, 7 nights" mental model does not match
  // either shipped adapter's price basis; this is where that mismatch is
  // recorded instead of being absorbed into a wrong total.
  //
  // A GENUINE per-unit supplier — one whose corpus price is per seat or per
  // night — must relax this DELIBERATELY, and the right shape for that is a
  // field on `SupplierItem` saying what the price covers, set by each adapter
  // and read here, so the answer travels with the item instead of being a
  // global assumption. That field is not added today because every supplier in
  // the repository would set the same value, which carries no information and
  // buys an unexercised code path plus a live-schema column. Add it with the
  // adapter that needs it.
  //
  // Filed as a `totals` violation, never thrown: this is model-controlled input
  // reaching a gate, and a gate returns violations.
  const multiplied = items.filter(
    (i) => Number.isSafeInteger(i.ref.quantity) && i.ref.quantity > 1,
  )
  if (multiplied.length > 0) {
    violations.push({
      gate: 'totals',
      sourceIds: multiplied.map((i) => i.item.sourceId),
      detail: `These items were proposed with a quantity above 1: `
            + `${multiplied.map((i) => `${sanitizeSourceId(i.item.sourceId)} (${i.ref.quantity})`).join(', ')}. `
            + `Every price in this system already covers the whole booking — a flight `
            + `price covers the whole party, a hotel price covers the whole stay — so `
            + `quantity must be 1. Propose each item once with quantity 1.`,
    })
  }

  if (violations.length > 0) return { violations, total: null }
  return { violations: [], total: sumMoney(items.map((i) => itemTotal(i.item, i.ref.quantity))) }
}

/**
 * Takes the total `checkTotals` already computed instead of recomputing it.
 * Two reasons, and neither is performance: a second sum is a second chance to
 * disagree with the first, and a budget gate that re-runs the totals gate
 * reports every totals fault a second time in its own words.
 *
 * So when there is no trustworthy total this returns NOTHING rather than a
 * second violation. That is a deliberate generalization and worth naming as
 * one: the requirement was that a MIXED-CURRENCY proposal yield a single
 * violation, and this suppresses for EVERY cause of a null total — mixed
 * currencies, mixed price bases, and a bad quantity alike. The reason it
 * generalizes is that the causes are indistinguishable in the only respect
 * budget cares about: there is no number to compare. `total === null` only
 * happens when `checkTotals` itself filed a violation (or the set was empty),
 * so the proposal is already rejected and restating the same fault under a
 * different gate name is the noise the gate stack exists to avoid.
 *
 * It is not failing open. Budget never invents a total, and never returns `[]`
 * for a proposal that HAD a total and exceeded it — but see the recording rule
 * below, because `[]` alone does not distinguish "passed" from "not run".
 *
 * `items` is here only to name the offenders in the message; the number under
 * test comes from `totals`. Note what this does NOT buy: `TotalsResult` is a
 * structural type, so a hand-built `{violations: [], total: money(999n,'EUR')}`
 * type-checks fine and nothing ties `totals` to `items`. Passing the
 * `TotalsResult` computed from THESE items is the caller's responsibility; the
 * signature makes it the obvious thing to do, not the only possible thing.
 *
 * See `checkTotals` for the recording rule: a `[]` from here means `pass` ONLY
 * when `totals.total` is non-null. Otherwise it means `not_evaluated`.
 *
 * Never throws. `compareMoney` throws on a currency mismatch, and the explicit
 * currency comparison immediately above it is the guard — the mismatch is
 * reported as a violation rather than raised. We refuse; we never convert,
 * because there is no FX rate in this codebase on purpose.
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
      detail: `The budget is set in ${budget.currency} but this trip totals in `
            + `${total.currency}. We do not convert; search in ${budget.currency}.`,
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
 * offset ("2026-09-12T16:40:00"); `new Date()` on one of those applies the
 * server's timezone and can roll a 23:59 departure into the next day, failing a
 * window the traveller's own calendar says is fine. Lexicographic comparison of
 * `yyyy-mm-dd` is exactly date ordering, so no parsing is needed at all.
 *
 * The test suite pins `TZ=America/Los_Angeles` precisely so that this stays
 * true under review: under `TZ=UTC` the offset is zero and a `new Date(...)`
 * implementation passes every one of these tests.
 *
 * Flights are windowed on their DEPARTURE dates only. An overnight leg that
 * departs on the last day of the window and lands the next morning is a normal
 * return, not a violation, and windowing arrivals too would reject it. Hotels
 * are windowed on both ends because a stay is bounded by both.
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
    if (dates.some((d) => d < window.earliest || d > window.latest)) {
      offenders.push(item.sourceId)
    }
  }
  if (offenders.length === 0) return []
  return [{
    gate: 'dates',
    sourceIds: offenders,
    detail: `These items fall outside the ${window.earliest} to ${window.latest} travel window: `
          + `${offenders.map(sanitizeSourceId).join(', ')}.`,
  }]
}

/** First 10 chars of an ISO timestamp — the date, with no parsing and no zone. */
function day(iso: string): string {
  return iso.slice(0, 10)
}
