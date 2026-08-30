import { money, type Money } from '../money.js'

export type SupplierKind = 'flight' | 'hotel'
export type PriceBasis = 'total' | 'pre_tax'

export type LegSummary = {
  from: string; to: string
  /** Naive ISO with NO offset. A string, deliberately never a Date. */
  departureLocal: string
  arrivalLocal: string
  stops: number
  route: string[]
  cabinClass: string
  carriers: string[]
  /**
   * One entry per segment, in segment order. `MockSupplier`'s two-segment
   * Ryanair leg is `['FR110', 'FR111']`; lesson 4.2's Kiwi adapter fills this
   * from the itinerary's own segment list.
   *
   * Lesson 4.6's cashier compares a re-quote per item and on item IDENTITY, not
   * just on the sum. Carrier alone is not identity: `FR1762` and `FR1763` are
   * the same airline on the same route at different times and under different
   * fare rules, and a refundable fare downgraded to basic economy differs by
   * flight number while every other field this type carries stays put.
   * Deliberately NOT deduplicated and NOT sorted: a two-segment leg flown twice
   * by the same number is a different itinerary from one flown once, and the
   * order is what makes this list comparable to `route`.
   */
  flightNumbers: string[]
}

export type FlightDetail = {
  kind: 'flight'
  outbound: LegSummary
  inbound: LegSummary | null
  baggage: { personalItem: number; cabinBag: number; checkedBag: number }
  totalDurationSeconds: number
  selfTransfer: boolean
}

export type HotelDetail = {
  kind: 'hotel'
  checkIn: string; checkOut: string; nights: number
  rating: number | null
  coordinates: { lat: number; lon: number } | null
  offerSource: string | null
}

/**
 * One thing a supplier is offering, normalised. Everything a gate needs to
 * judge it, and nothing a model wrote: from lesson 4.3 on, every field of every
 * item a gate sees is read back out of `course.tool_results`.
 */
export type SupplierItem = {
  sourceId: string
  supplier: string
  kind: SupplierKind
  name: string
  price: Money
  priceBasis: PriceBasis
  fetchedAt: Date
  ttlSeconds: number
  bookingUrl: string | null
  detail: FlightDetail | HotelDetail
}

export type FlightSearch = {
  kind: 'flight'
  from: string; to: string
  /** ISO yyyy-mm-dd. */
  departureDate: string; returnDate: string | null
  flexDays: number
  adults: number; children: number; infants: number
  cabinClass: string
  currency: string
  maxStops: number | null
  allowSelfTransfer: boolean
}

export type HotelSearch = {
  kind: 'hotel'
  query: string
  checkIn: string; checkOut: string
  adults: number
  currency: string
}

export type SearchParams = FlightSearch | HotelSearch

/**
 * What a supplier says it is able to do. The cashier (lesson 4.6) reads this
 * before it claims anything to her: a supplier that cannot re-quote must not be
 * described as verified, because a control that increases trust without
 * increasing safety is worse than no control.
 */
export type SupplierCapabilities = {
  /** Can we get a real-time price at all? */
  live: boolean
  /** Is there a verification endpoint distinct from search? */
  mayRequote: boolean
  /** Beyond this many seconds, a price is not quotable. */
  maxAgeSeconds: number
  /** How long this supplier's terms let us hold a price. Read by module 5.2's trimForContext. */
  pricePersistence: 'none' | 'session' | '24h' | 'indefinite'
}

/**
 * The one shared home for the default freshness window. `MockSupplier` and
 * lesson 4.2's Kiwi adapter both quote a `maxAgeSeconds` of 900; two consumers
 * hard-coding the same number independently is how they drift out of sync the
 * first time one of them changes. Same precedent as `DEFAULT_LIMITS` in
 * `src/limits.ts`.
 */
export const DEFAULT_MAX_AGE_SECONDS = 900

/**
 * Three answers to "what does this cost now", and the third is the one that
 * matters. `gone` is a fact: we searched and it is not there. `unavailable` is
 * an absence of fact: we could not find out. They get opposite treatment at the
 * cashier, because unknown is not unchanged.
 */
export type QuoteOutcome =
  | { status: 'ok'; item: SupplierItem }
  | { status: 'gone' }
  | { status: 'unavailable'; reason: string }

export interface Supplier {
  readonly name: string
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]>
  quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome>
}

/**
 * One supplier per kind, which is what a tool runner needs: the model asks for
 * flights or hotels and something has to decide which endpoint that is. Kept
 * here rather than in `src/tools.ts` so `src/supplier/mock.ts` can build one
 * without importing the tool layer, which imports it back.
 */
export type SupplierPair = { flight: Supplier; hotel: Supplier }

/**
 * `quantity` is a count of identical units, so this is integer multiplication
 * in minor units and never a float multiply. A non-integer quantity is a caller
 * bug, not a rounding question: there is no correct way to charge 1.5 of a
 * seat, so it throws rather than picking one.
 *
 * ## Read this before passing anything other than 1
 *
 * This function multiplies; it does NOT know what `item.price` covers. For
 * every supplier this branch ships, the price already covers the whole booking,
 * so the only correct quantity is 1:
 *
 *  - **Kiwi** (lesson 4.2) returns a party total. The captured fixture's search
 *    is 2 adults and the itinerary is priced 464 EUR, which is 464 for the pair
 *    and not per seat. Multiplying by the passenger count doubles a price that
 *    already counted them.
 *  - **SearchApi** (lesson 4.2) reads `total_price`, which is the whole stay.
 *    `HotelDetail.nights` is derived from the requested window and is
 *    descriptive, never a multiplier.
 *  - **MockSupplier** mirrors both, quoting one price per item.
 *
 * So `checkTotals` (`src/gates/checks.ts`, lesson 4.5) refuses a model-supplied
 * quantity other than 1 and files a `totals` violation. That check is the
 * enforcement point; this function stays a pure multiplier because a genuine
 * per-unit supplier would need it, and because a gate is the right place to
 * turn a model's mistake into a message rather than into an exception.
 */
export function itemTotal(item: SupplierItem, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError(`itemTotal: quantity must be a positive integer, got ${quantity}`)
  }
  return money(item.price.minor * BigInt(quantity), item.price.currency)
}

/**
 * Both narrowings key off `detail.kind` and never off the sibling `kind` field.
 * The two are not coupled by this type, and from lesson 4.3 the corpus reads
 * `detail` back as jsonb the type system never saw written, so a row where they
 * disagree is possible. Every gate that asks "what is this?" has to ask the
 * same field, or one inconsistent row is slot-checked as a flight and
 * date-checked as a hotel.
 */
export function isFlight(i: SupplierItem): i is SupplierItem & { detail: FlightDetail } {
  return i.detail.kind === 'flight'
}
export function isHotel(i: SupplierItem): i is SupplierItem & { detail: HotelDetail } {
  return i.detail.kind === 'hotel'
}
