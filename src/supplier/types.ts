import { money, type Money } from '../money.js'

export type SupplierKind = 'flight' | 'hotel'
export type PriceBasis = 'total' | 'pre_tax'

export type LegSummary = {
  from: string; to: string
  departureLocal: string     // naive ISO, NO offset — a string, deliberately never a Date
  arrivalLocal: string
  stops: number
  route: string[]
  cabinClass: string
  carriers: string[]
  /**
   * One entry per segment, in segment order, e.g. `['U22202', 'LS875']`.
   *
   * §6 names `flight_no` in the normalised `tool_results` shape and §5 requires
   * the cashier to compare "per item and on item identity, not just on the
   * sum". Carrier alone is not identity: `FR1762` and `FR1763` are the same
   * airline on the same route at different times and different fare rules, and
   * a refundable fare downgraded to basic economy differs by flight number
   * while every other field this type carries stays put. Deliberately NOT
   * deduplicated and NOT sorted — a two-segment leg flown twice by the same
   * number is a different itinerary from one flown once, and order is what
   * makes the list comparable to `route`.
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
  departureDate: string; returnDate: string | null   // ISO yyyy-mm-dd
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
 * What the corpus can give back about one item: everything `SupplierItem`
 * carries, plus the search that found it.
 *
 * `searchParams` is NOT on `SupplierItem` on purpose. A `SupplierItem` is what a
 * supplier returned for one item; the search that produced it is a property of
 * the fetch, not of the item, and every supplier adapter constructs
 * `SupplierItem` values without knowing how they will be stored. Widening
 * `SupplierItem` would force every adapter to carry a field none of them can
 * populate meaningfully.
 *
 * Nullable because rows written before migration 0011 have `'{}'::jsonb` from
 * the column default rather than a real search — an empty object is not a
 * search, and the cashier must be able to tell "no search recorded" from "a
 * search with no filters" rather than re-quoting against a fabricated one.
 */
export type StoredItem = SupplierItem & {
  searchParams: SearchParams | null
}

export type SupplierCapabilities = {
  live: boolean
  mayRequote: boolean
  maxAgeSeconds: number
  pricePersistence: 'none' | 'session' | '24h' | 'indefinite'
}

/**
 * The one shared home for the mock item freshness window. Both `MockSupplier`
 * and the later Kiwi adapter quote a `maxAgeSeconds`/`ttlSeconds` of 900; two
 * consumers hard-coding the same number independently is how they drift out
 * of sync the first time one of them changes. Same precedent as
 * `DEFAULT_LIMITS` in `src/limits.ts`.
 */
export const DEFAULT_MAX_AGE_SECONDS = 900

export type QuoteOutcome =
  | { status: 'ok'; item: SupplierItem }
  | { status: 'gone' }                          // searched and absent → genuinely unavailable
  | { status: 'unavailable'; reason: string }   // could not verify → BLOCKS hand-off

export interface Supplier {
  readonly name: string
  readonly kind: SupplierKind
  readonly capabilities: SupplierCapabilities
  search(params: SearchParams, signal?: AbortSignal): Promise<SupplierItem[]>
  quote(sourceId: string, params: SearchParams, signal?: AbortSignal): Promise<QuoteOutcome>
}

/**
 * `quantity` is a count of identical units, so this is integer multiplication
 * in minor units and never a float multiply. A non-integer quantity is a caller
 * bug, not a rounding question — there is no correct way to charge 1.5 of a
 * seat, so it throws rather than picking one.
 *
 * ## Read this before passing anything other than 1
 *
 * This function multiplies; it does NOT know what `item.price` covers. For
 * every supplier this repository ships, the corpus price already covers the
 * whole booking, so the only correct quantity is 1:
 *
 *  - **Kiwi** returns a party total. The captured fixture's search is
 *    `2 adults` and the itinerary is priced `464` EUR — €464 for the pair, not
 *    per seat. Multiplying by the passenger count doubles a price that already
 *    counted them.
 *  - **SearchApi** reads `total_price`, which is the whole stay; `nights` is
 *    derived from the requested window and is descriptive, not a multiplier.
 *  - **MockSupplier** mirrors both, quoting one price per item.
 *
 * So `checkTotals` (src/gates/checks.ts) refuses a model-supplied quantity
 * other than 1 and files a `totals` violation. That check is the enforcement
 * point; this function stays a pure multiplier because a genuine per-unit
 * supplier would need it, and because a gate is the right place to turn a
 * model's mistake into a message rather than an exception.
 */
export function itemTotal(item: SupplierItem, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError(`itemTotal: quantity must be a positive integer, got ${quantity}`)
  }
  return money(item.price.minor * BigInt(quantity), item.price.currency)
}

export function isFlight(i: SupplierItem): i is SupplierItem & { detail: FlightDetail } {
  return i.detail.kind === 'flight'
}
export function isHotel(i: SupplierItem): i is SupplierItem & { detail: HotelDetail } {
  return i.detail.kind === 'hotel'
}
