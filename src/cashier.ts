import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { exceedsAnyCeiling, whichCeiling, type Limits } from './engine.js'
import type { ItemRef } from './gates/types.js'
import { compareMoney, formatMoney, sumMoney, type Money } from './money.js'
import { emittedForProposal, recordLinkClicks, type EmittedLink } from './repo/linkClicks.js'
import { loadProposal } from './repo/proposals.js'
import { readSpendFailClosed } from './repo/spend.js'
import { rehydrate, searchParamsFor } from './repo/toolResults.js'
import {
  isFlight,
  type FlightDetail, type QuoteOutcome, type SupplierItem, type SupplierPair,
} from './supplier/types.js'
import type { ToolRunner } from './tools.js'

/**
 * The affiliate id we identify ourselves with. A real one is a per-supplier
 * account and would come from configuration; this branch has one placeholder so
 * that the SHAPE of the URL is right and the value is obviously not a live
 * account. It is never read from the environment, because a missing value would
 * silently emit an unattributed link rather than failing.
 */
const AFFILIATE_ID = 'globetrotty-course'

/**
 * The only hosts a link she is given may point at.
 *
 * The model never supplies a URL and never sees one: `itemForModel`
 * (src/tools.ts) drops `bookingUrl` on the way out. This is the other half of
 * that. A planning desk holds her private data, reads untrusted listings and
 * emits URLs, which is a complete exfiltration path with a working exit, and
 * fencing does not touch it because a URL is not prompt text. So every link is
 * built here, from `(supplier, sourceId, tracking ref)`, against a fixed
 * per-supplier template, and the host is re-parsed off the finished string and
 * compared with this map before it is returned.
 */
export const BOOKING_HOSTS: Record<string, string> = {
  kiwi: 'www.kiwi.com',
  searchapi: 'www.google.com',
  mock: 'example.invalid',
}

const TEMPLATES: Record<string, (itemId: string, trackingRef: string) => string> = {
  kiwi: (id, ref) =>
    `https://www.kiwi.com/deep?itinerary=${encodeURIComponent(id)}`
  + `&affilid=${encodeURIComponent(AFFILIATE_ID)}&subid=${encodeURIComponent(ref)}`,
  searchapi: (id, ref) =>
    `https://www.google.com/travel/hotels/entity/${encodeURIComponent(id)}`
  + `?ap=${encodeURIComponent(`${AFFILIATE_ID}-${ref}`)}`,
  mock: (id, ref) =>
    `https://example.invalid/book/${encodeURIComponent(id)}?subid=${encodeURIComponent(ref)}`,
}

export class UnknownSupplierError extends Error {
  constructor(readonly supplier: string) {
    super(`No booking template for supplier '${supplier}'; refusing to build a link`)
    this.name = 'UnknownSupplierError'
  }
}

/**
 * One link, built server side, on an allowlisted host, carrying our tracking
 * ref as the affiliate sub-id.
 *
 * `Object.hasOwn`, never a bare index, for the reason `checkSlots` gives
 * (src/gates/checks.ts): `TEMPLATES['toString']` resolves through
 * Object.prototype and returns a function, which is truthy, and the code would
 * then call it with two strings and build something nobody wrote.
 *
 * The host is re-parsed off the finished URL and compared with `BOOKING_HOSTS`
 * rather than trusted from the template. `itemId` is supplier-supplied text
 * that reached us through the corpus, so `encodeURIComponent` is the fix and
 * this comparison is the proof that the fix held: an id carrying an `@`, a `?`
 * or a `#` cannot move the host, and if a template is ever edited into
 * something that can, this throws instead of emitting it.
 */
export function bookingUrl(supplier: string, itemId: string, trackingRef: string): string {
  if (!Object.hasOwn(TEMPLATES, supplier)) throw new UnknownSupplierError(supplier)
  const url = TEMPLATES[supplier]!(itemId, trackingRef)
  const host = new URL(url).hostname
  const allowed = BOOKING_HOSTS[supplier]
  if (host !== allowed) {
    throw new Error(`bookingUrl: ${supplier} built a link on ${host}, not ${allowed}`)
  }
  return url
}

/** "2 hours ago", "2 days ago", "just now". Whole units, because a price's age is not a stopwatch. */
function describeAge(quotedAt: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - quotedAt.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The sentence she reads, and the one place the difference between a verified
 * hand-off and an unverified one is expressed in words.
 *
 * When `verified` is false this does NOT claim verification. The copy becomes
 * disclosure and the price renders with its age, because a supplier that cannot
 * re-quote has told us so and saying "we checked" anyway is the control that
 * increases trust without increasing safety.
 *
 * Rebuildable from the stored rows alone, which is why `link_clicks.verified`
 * and `link_clicks.quoted_at` are both columns: a worker that dies after
 * emitting has to be able to say the same sentence again (src/worker.ts).
 * Re-deriving `verified` would mean re-quoting, which is exactly what rule 6
 * forbids after emission, and re-deriving the age from the clock would print
 * "just now" over a price quoted hours ago.
 */
export function handOffMessage(
  links: EmittedLink[], verified: boolean, quotedAt: Date, now: Date,
): string {
  const total = sumMoney(links.map((l) => l.quoted))
  const lines = links.map((l) => `${formatMoney(l.quoted)}: ${l.url}`).join('\n')
  if (verified) {
    return `We checked every price again just now. Your trip comes to ${formatMoney(total)}. `
         + `Open each link to book:\n${lines}`
  }
  // Plural when the set came from more than one supplier. `verified` is an AND
  // across all of them, so one adapter that cannot re-quote makes the whole
  // hand-off unverified, and "this supplier" would then be describing two or
  // three of them while quietly implying the others were checked.
  const suppliers = new Set(links.map((l) => l.supplier))
  const cannot = suppliers.size > 1
    ? 'Not every supplier here can confirm a price on request, so we have not asked them again: '
    // "not re-checked" is deliberately NOT the wording, though it is the
    // plainer English: the whole rule is that an unverified hand-off must
    // not contain the words a verified one does, and a reader scanning for
    // "checked" would find it here in a sentence that means the opposite.
    // test/cashier-links.test.ts pins that as a regex over this string.
    : 'This supplier cannot confirm a price on request, so we have not asked it again: '
  return `This was ${formatMoney(total)} when we found it, ${describeAge(quotedAt, now)}. `
       + cannot
       + `prices move, so check the total before you pay.\n${lines}`
}

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
 * grew the part that re-quotes before she is given a link.
 */
export function totalOf(items: SupplierItem[]): Money {
  return sumMoney(items.map((item) => item.price))
}

/** Whether a total fits a budget. Throws rather than compare two currencies. */
export function fitsBudget(total: Money, budget: Money): boolean {
  return compareMoney(total, budget) <= 0
}

/**
 * How long an acceptance stays good. She said yes to a set of prices, and half
 * an hour later that yes is about a trip she has stopped looking at.
 */
export const DECISION_MAX_AGE_SECONDS = 1800

/**
 * How far a re-quoted price may move and still be the price she accepted, in
 * basis points of that price. Half a percent, chosen and written down rather
 * than falling out of a `>` somewhere: a tolerance nobody picked is a tolerance
 * that turns out to be zero the day a supplier rounds differently, or infinite
 * the day somebody compares the wrong pair of numbers.
 *
 * Integer arithmetic, in minor units, like every other comparison in this
 * codebase. `Math.abs(after - before) * 10_000 > before * TOLERANCE_BPS` has no
 * float in it at any point.
 */
export const TOLERANCE_BPS = 50n

export type HandOffRefusal =
  | { kind: 'no_proposal'; detail: string; sourceIds: string[] }
  | { kind: 'not_accepted'; detail: string; sourceIds: string[] }
  | { kind: 'stale_decision'; detail: string; sourceIds: string[] }
  | { kind: 'limit_reached'; detail: string; sourceIds: string[] }
  | { kind: 'unverifiable'; detail: string; sourceIds: string[] }
  | { kind: 'moved'; detail: string; sourceIds: string[] }
  /**
   * This proposal has already been handed off. Not an error and not a retry:
   * the links exist, she has them, and rule 6 says nothing may re-quote a set
   * that has been emitted. It is a refusal rather than a replay because the
   * message that went with those links was already given to the model, and
   * saying it twice would tell her we checked the prices again just now.
   */
  | { kind: 'already_emitted'; detail: string; sourceIds: string[] }

export type HandOff =
  | { ok: true; verified: boolean; links: EmittedLink[]; message: string }
  | { ok: false; refusal: HandOffRefusal }

const refuse = (kind: HandOffRefusal['kind'], detail: string, sourceIds: string[] = []): HandOff =>
  ({ ok: false, refusal: { kind, detail, sourceIds } as HandOffRefusal })

/** Whether two prices are the same price, within the stated tolerance, in integer minor units. */
function withinTolerance(before: Money, after: Money): boolean {
  if (before.currency !== after.currency) return false
  const drift = after.minor > before.minor ? after.minor - before.minor : before.minor - after.minor
  return drift * 10_000n <= before.minor * TOLERANCE_BPS
}

/**
 * Whether a re-quote came back as the SAME thing, not merely at the same price.
 *
 * A total that fell because a refundable fare became basic economy is a
 * downgrade she never accepted, and the sum cannot see it. `flightNumbers` is
 * the field that can: it is per segment, in order (src/supplier/types.ts), so a
 * one-segment itinerary and a two-segment one differ here even when carrier,
 * route, times and price all stay put. `priceBasis` matters for the same
 * reason: an all-in price replaced by a pre-tax price of the same magnitude is
 * a different number about a different thing.
 */
function sameItinerary(before: SupplierItem, after: SupplierItem): boolean {
  // The id and the adapter first. Both live adapters re-quote by native id and
  // hand back what they were asked about, so nothing on this branch can return
  // a substitute; an adapter that answered "the nearest available room" would
  // otherwise pass every check below and put her on a link to an item the gates
  // never approved, stored under an `item_id` the unique constraint then fails
  // to protect.
  if (before.sourceId !== after.sourceId || before.supplier !== after.supplier) return false
  if (before.priceBasis !== after.priceBasis) return false
  if (before.price.currency !== after.price.currency) return false
  if (!isFlight(before) || !isFlight(after)) return true
  const legs = (i: SupplierItem & { detail: FlightDetail }) =>
    [...i.detail.outbound.flightNumbers, '|', ...(i.detail.inbound?.flightNumbers ?? [])].join(',')
  return legs(before) === legs(after)
}

/**
 * The cashier. Six rules, in order, and the last one changes what the rest of
 * the system is allowed to do afterwards.
 *
 * 1. Refuse unless the STORED proposal row for THIS conversation carries
 *    `decision = 'accept'`, decided within DECISION_MAX_AGE_SECONDS. The model
 *    passes a proposal id; it never passes an itinerary.
 * 2. Where the supplier says it can re-quote, re-quote every item. Any item
 *    whose re-quote does not return a fresh, successful, same-currency price
 *    BLOCKS the hand-off, because unknown is not unchanged: a transport failure
 *    and a fare that is genuinely gone are both "we could not confirm this",
 *    and neither is "it is fine".
 * 3. Compare per item and on item identity, not just on the sum. Tolerance is
 *    an explicit half a percent (TOLERANCE_BPS), not an accident of `>`.
 * 4. Where the supplier says it CANNOT re-quote, do not claim verification. The
 *    copy becomes disclosure, with the price's age (handOffMessage above).
 * 5. Build every URL server side from (supplier, sourceId, tracking ref) via a
 *    fixed per-supplier template with an allowlisted hostname; mint the
 *    link_clicks id FIRST and embed it as the sub-id; store the exact emitted
 *    URL (bookingUrl above, recordLinkClicks).
 * 6. Link emission is the point of no return. After it, nothing may mark the
 *    turn failed, nothing may tell her the request failed, nothing may
 *    re-quote that set, everything is best effort. Enforced where a turn can
 *    END, and through ONE function rather than two agreeing implementations:
 *    `completeIfLinkEmitted` (src/worker.ts) reads course.link_clicks and, if
 *    anything went out, ends the turn `done` with the sentence handOffMessage
 *    said. runTurn's catch calls it directly; loop's four failTurn exits and
 *    continueLater's cap arm call it through failTurnUnlessLinkEmitted; and
 *    src/sweeper.ts's crash arm calls it too, with its own closer, because a
 *    worker that died outright never reached any of those. Five failing exits
 *    plus the catch plus the floor walk, and none of them can write
 *    `status = 'failed'` on a turn that emitted.
 *
 *    The re-quote half is enforced here, by the refusal above: a second
 *    hand-off of a proposal that already emitted is refused before a supplier
 *    is asked anything. What is NOT enforced anywhere is the two paths that
 *    REQUEUE a turn instead of ending it (continueLater's hand-back and the
 *    sweeper's requeue arm); README.md names that as a residual.
 *
 * The re-quote deliberately does NOT go through `ledgerRunner`. Every other
 * supplier call on this branch does, because a replayed search is a correct
 * search; a replayed QUOTE is the stale price this function exists to check,
 * handed back with a straight face. The emission does go through the ledger,
 * because `hand_off_to_booking` is a tool call like any other and a crash
 * between minting the rows and finishing the ledger row is exactly the
 * ambiguous case lesson 3.4 wrote the operator step for.
 */
export async function handOffToBooking(
  sql: postgres.Sql,
  args: {
    proposalId: string
    conversationId: string
    userId: string
    turnId: string | null
    suppliers: SupplierPair
    limits: Limits
    now: Date
    /**
     * The fenced worker's own signal (`AgentContext.signal`, src/worker.ts),
     * threaded into every `supplier.quote` below and checked once more before
     * anything is written. A re-quote that runs to completion after this
     * worker has been superseded writes `course.link_clicks` rows stamped with
     * a turn the NEW worker owns and hands two live booking URLs to a model
     * whose turn is already dead. Optional, because a script and a test have no
     * signal to give, exactly like `Supplier.search` and `Supplier.quote`.
     */
    signal?: AbortSignal
  },
): Promise<HandOff> {
  // Rule 1. Read by (id, conversation_id), never by id alone: a proposal id
  // that leaked into another thread must not be spendable from there.
  const proposal = await loadProposal(sql, args.proposalId, args.conversationId)
  if (!proposal) {
    return refuse('no_proposal', `No proposal ${args.proposalId} in this conversation.`)
  }
  // The composite foreign key ties the proposal to the conversation's owner and
  // every caller derives both ids from one claim, so these agree today. They
  // are compared anyway because the two reads below do not: the ceiling is read
  // for `args.userId`, and `link_clicks.user_id` is written from it with no key
  // of its own, so a mismatch would check one person's ceiling and leave a row
  // filed under the other. The same sentence as a proposal that does not exist,
  // deliberately: from the model's side those are one fact, and a refusal that
  // distinguished them would confirm that somebody else's proposal id is real.
  if (proposal.userId !== args.userId) {
    return refuse('no_proposal', `No proposal ${args.proposalId} in this conversation.`)
  }
  if (proposal.refs.length === 0) {
    // `ProposalRefsSchema` has `.min(1)`, so `proposalRunner` cannot write this
    // row; `loadProposal` returns `refs` straight out of `jsonb` with no
    // validation and lesson 5.7 will be a second writer of this table. A
    // refusal is cheaper than "Reduce of empty array" from the oldest-quote
    // fold below.
    return refuse('no_proposal', `Proposal ${proposal.id} carries no items to hand off.`)
  }
  if (proposal.decision !== 'accept' || !proposal.decidedAt) {
    return refuse('not_accepted',
      `Proposal ${proposal.id} has not been accepted (decision: ${proposal.decision ?? 'none yet'}).`)
  }
  const ageSeconds = (args.now.getTime() - proposal.decidedAt.getTime()) / 1000
  if (ageSeconds > DECISION_MAX_AGE_SECONDS) {
    return refuse('stale_decision',
      `Proposal ${proposal.id} was accepted ${Math.round(ageSeconds / 60)} minutes ago; `
    + `an acceptance is good for ${DECISION_MAX_AGE_SECONDS / 60} minutes. Re-propose it.`)
  }

  // Rule 6, read from the other side: a set that has already been emitted may
  // not be re-quoted, so a second hand-off of the same proposal is decided here
  // and nothing is asked of a supplier. `unique (proposal_id, item_id)` makes
  // the second write impossible either way, but as an unhandled Postgres error
  // rather than an answer: rescued into a `done` turn on tier 3 by
  // `runTurn`'s catch, and a dead script in `scripts/trip.ts` and
  // `scripts/demo.ts`. The model reaches here with a fresh `callId`, so
  // `ledgerRunner` replays nothing.
  const already = await emittedForProposal(sql, proposal.id)
  if (already.length > 0) {
    return refuse('already_emitted',
      `Proposal ${proposal.id} has already been handed off: ${already.length} booking `
    + `link${already.length === 1 ? '' : 's'} went out, and the prices behind them may not be `
    + 'asked again. She has them already; do not repeat them as if they were checked just now.',
      already.map((l) => l.sourceId))
  }

  // The ceiling built in lesson 2.6, now standing between the model and a
  // booking link. Nothing new: the same fail-closed read, the same three
  // ceilings, the same UTC day. What is new is where it stands, and that a
  // hand-off is the last place a run can be stopped for free.
  const spend = await readSpendFailClosed(sql, args.userId, args.conversationId)
  if (exceedsAnyCeiling(spend, args.limits)) {
    return refuse('limit_reached',
      `Stopping before the hand-off: the ${whichCeiling(spend, args.limits)} ceiling is reached.`)
  }

  const sourceIds = proposal.refs.map((r) => r.sourceId)
  const [corpus, params] = await Promise.all([
    rehydrate(sql, args.conversationId, sourceIds),
    searchParamsFor(sql, args.conversationId, sourceIds),
  ])
  const missing = sourceIds.filter((id) => !corpus.has(id) || !params.has(id))
  if (missing.length > 0) {
    // The gates approved these ids against this corpus, so this cannot happen
    // through any path this branch has. It is `unverifiable` rather than
    // `no_proposal` because the honest description is that we could not confirm
    // the items, which is the same class of answer as a failed re-quote.
    return refuse('unverifiable',
      `These items are no longer in this conversation's search results: ${missing.join(', ')}.`,
      missing)
  }

  const quoted: { item: SupplierItem; ref: ItemRef; supplier: string }[] = []
  let verified = true
  for (const ref of proposal.refs) {
    const stored = corpus.get(ref.sourceId)!
    const supplier = stored.kind === 'flight' ? args.suppliers.flight : args.suppliers.hotel

    // Rule 4. A supplier that says it cannot re-quote is believed, and nothing
    // is asked of it: asking anyway is exactly the control that compares a
    // cache with itself and reports agreement.
    if (!supplier.capabilities.mayRequote) {
      verified = false
      quoted.push({ item: stored, ref, supplier: stored.supplier })
      continue
    }

    // Rule 2. Not through the ledger, on purpose: see the docstring. The
    // caller's signal travels with it, so a fence landing mid re-quote cancels
    // the request instead of paying for an answer nobody may act on.
    let outcome: QuoteOutcome
    try {
      outcome = await supplier.quote(ref.sourceId, params.get(ref.sourceId)!, args.signal)
    } catch (err) {
      // An aborted call is not a supplier that could not confirm a price, and
      // must not be described to the model as one: the turn is over. It leaves
      // as the signal's own reason, which is the FencedError `withHeartbeat`
      // captured, exactly as `supplierRunner` does with a cancelled search
      // (src/tools.ts).
      if (args.signal?.aborted) throw args.signal.reason
      return refuse('unverifiable',
        `Could not re-check ${ref.sourceId} with ${supplier.name}: ${err instanceof Error ? err.message : String(err)}. `
      + 'We do not hand over a price we could not confirm.', [ref.sourceId])
    }
    if (outcome.status !== 'ok') {
      return refuse('unverifiable',
        `${supplier.name} could not confirm ${ref.sourceId} (${outcome.status}`
      + `${outcome.status === 'unavailable' ? `: ${outcome.reason}` : ''}). `
      + 'We do not hand over a price we could not confirm.', [ref.sourceId])
    }

    // Rule 3, both halves, per item.
    if (!sameItinerary(stored, outcome.item)) {
      return refuse('moved',
        `${ref.sourceId} came back as a different itinerary or a different kind of price than the `
      + 'one accepted (the flight numbers, the currency or the price basis changed). '
      + 'Search again and propose the new result.', [ref.sourceId])
    }
    if (!withinTolerance(stored.price, outcome.item.price)) {
      return refuse('moved',
        `${ref.sourceId} moved from ${formatMoney(stored.price)} to ${formatMoney(outcome.item.price)}, `
      + `more than the ${Number(TOLERANCE_BPS) / 100}% we allow. Search again and propose the new price.`,
        [ref.sourceId])
    }
    // The NEW price, not the accepted one: verifying one number and then
    // emitting another is worse than not verifying at all.
    quoted.push({ item: outcome.item, ref, supplier: stored.supplier })
  }

  // Rule 5. The id is minted here, before the URL exists, because it IS the
  // sub-id inside the URL.
  //
  // The link is addressed from the ACCEPTED reference and the corpus row's
  // supplier, never from the re-quoted item: what she accepted is what she is
  // sent to, and the re-quote's only job is the price. `sameItinerary` already
  // refuses a re-quote whose id or adapter moved, so the two agree by the time
  // this runs; building from the pair the gates approved means they cannot
  // disagree even if that check is ever loosened. The PRICE is the new one, for
  // the reason the loop above gives.
  const links: EmittedLink[] = quoted.map(({ item, ref, supplier }) => {
    const id = randomUUID()
    return {
      id,
      sourceId: ref.sourceId,
      supplier,
      trackingRef: id,
      url: bookingUrl(supplier, ref.sourceId, id),
      quoted: item.price,
    }
  })

  // The OLDEST quote in the set, computed before the write because it is stored
  // with it: the sentence discloses one age, and the honest one is the age of
  // the stalest number in the trip rather than of the freshest.
  const quotedAt = quoted
    .map(({ item }) => item.fetchedAt)
    .reduce((oldest, at) => (at < oldest ? at : oldest))

  // The last moment this can be stopped for free. A fence that landed while the
  // re-quote was in flight means another worker owns this turn now, and writing
  // these rows would file them under a turn it is running from scratch and hand
  // two live URLs to a model whose turn is dead. Checked here rather than only
  // around the quote, because a set that needed no re-quote at all (rule 4)
  // reaches this line without ever touching a supplier.
  if (args.signal?.aborted) throw args.signal.reason

  // Rule 6 begins here. Everything above may refuse; nothing below may.
  await recordLinkClicks(sql, {
    proposalId: proposal.id, turnId: args.turnId, userId: args.userId, verified, quotedAt, links,
  })

  return { ok: true, verified, links, message: handOffMessage(links, verified, quotedAt, args.now) }
}

/**
 * Who the hand-off belongs to. The three ids and nothing else, declared here
 * rather than taken from `ProposalContext` (src/gates/runner.ts) or from a
 * `Claim` (src/repo/turns.ts): the gates need a notebook and a clock that this
 * does not, and a `Claim` cannot express the `turnId: null` a hand-off made
 * outside a turn carries, which is the shape `scripts/demo.ts` uses.
 */
export type CashierContext = {
  conversationId: string
  userId: string
  turnId: string | null
}

/**
 * The `hand_off_to_booking` link of the runner chain, composed outside
 * `proposalRunner` and, on tier 3, inside `ledgerRunner`:
 *
 *   ledgerRunner(sql, claim,
 *     cashierRunner(sql, ctx, deps,
 *       proposalRunner(sql, ctx,
 *         corpusRunner(sql, claim,
 *           supplierRunner(suppliers)))))
 *
 * That is netlify/functions/run-turn-background.mts. `scripts/trip.ts` composes
 * the same four wrappers WITHOUT the ledger, on purpose (one process, no crash
 * to resume from, nothing to replay), which means the paragraph below is a
 * property of tier 3 and not of this function: `npm run trip` has no
 * `beginToolCall` row standing behind its hand-off.
 *
 * Inside the ledger deliberately, and it is the one place on this branch where
 * that matters for a side effect rather than for a cost. A crash between
 * minting the `link_clicks` rows and `finishToolCall` recording the outcome
 * leaves a `pending` ledger row, so the resumed turn reports `ambiguous` and
 * ends `ambiguous_tool_call` rather than emitting a second set of links. That
 * is the operator step lesson 3.4 wrote down, and this is the call it was
 * written for: `select * from course.tool_calls where status = 'pending'`, read
 * `course.link_clicks` for that turn, and decide.
 *
 * A refusal comes back as `isError: true` with the reason, like a gate
 * rejection, because a hand-off the cashier declined is something the model can
 * act on: re-search, re-propose, ask her again.
 */
export function cashierRunner(
  sql: postgres.Sql,
  ctx: CashierContext,
  deps: { suppliers: SupplierPair; limits: Limits; now: () => Date },
  inner: ToolRunner,
): ToolRunner {
  return async (name, input, callId, signal) => {
    if (name !== 'hand_off_to_booking') return inner(name, input, callId, signal)
    const proposalId = (input as { proposalId?: unknown } | null)?.proposalId
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      return { content: 'hand_off_to_booking needs a proposalId string.', isError: true }
    }
    const result = await handOffToBooking(sql, {
      proposalId,
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      turnId: ctx.turnId,
      suppliers: deps.suppliers,
      limits: deps.limits,
      now: deps.now(),
      signal,
    })
    if (!result.ok) {
      return {
        content: JSON.stringify({ ok: false, refusal: result.refusal }),
        isError: true,
      }
    }
    return {
      content: JSON.stringify({
        ok: true, verified: result.verified, message: result.message,
        // The URLs go to her through the message, and to the model as well:
        // there is nothing secret in them, they were built here, and a model
        // that cannot see what it just did cannot describe it to her.
        links: result.links.map((l) => ({ sourceId: l.sourceId, url: l.url })),
      }),
      isError: false,
    }
  }
}
