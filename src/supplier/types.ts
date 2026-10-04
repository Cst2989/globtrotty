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
/**
 * One nearby place a property lists, with the travel time it quoted for it. Both strings are
 * supplier-authored and masked at the adapter boundary (src/supplier/searchapi.ts), the same
 * trust class as a carrier name.
 */
export type NearbyPlace = {
  name: string
  /** Minutes, or `null` when the property named the place without a duration. */
  minutes: number | null
  /** 'Taxi' / 'Public transport' / 'Walking' — the supplier's own transport word, masked. */
  by: string | null
}

/**
 * Everything a Booking-grade hotel card needs, which is a great deal more than the four fields
 * this carried before the hotels pass. Each supplier-authored field is capped AND masked by the
 * adapter rather than by the renderer, because the adapter is the boundary and the corpus
 * (`tool_results.payload`) stores whatever lands here verbatim.
 *
 * Widening this needed no migration: the corpus stores the whole `SupplierItem` as JSON, so an
 * older row simply lacks the new fields and `web/data.ts`'s reader defaults each one.
 */
export type HotelDetail = {
  kind: 'hotel'
  checkIn: string; checkOut: string; nights: number
  rating: number | null
  coordinates: { lat: number; lon: number } | null
  offerSource: string | null
  /**
   * SearchApi's own `type` field, narrowed to three values. `'other'` covers a type outside the
   * two it documents — an unknown string never reaches a card as a label, and a "Hotel" badge on
   * something that is not one is exactly the lie the Type filter exists to prevent.
   */
  propertyType: 'hotel' | 'rental' | 'other'
  /** Hotel class in stars (`extracted_hotel_class`), 1-5, or `null` for an unclassified property. */
  stars: number | null
  /** How many reviews the rating is computed from; `null` when absent. */
  reviews: number | null
  /** SearchApi's own `location_rating`, 0-5, or `null`. */
  locationRating: number | null
  /**
   * Up to 5 photo URLs, https only, and ONLY from Google's own image hosts — see
   * `allowedImageUrl` in src/supplier/searchapi.ts. These end up in an `<img src>` under a CSP
   * that names exactly those hosts, so a `javascript:` or `http://evil` URL is dropped at the
   * adapter rather than left to be blocked later.
   */
  images: string[]
  /** Up to 12 amenity labels, masked, each at most 40 characters. */
  amenities: string[]
  /** Up to 6 `essential_info` labels ("Entire house", "Sleeps 4"), masked, 40 characters each. */
  essentials: string[]
  /** Up to 3 nearby places, in the order the supplier listed them. */
  nearby: NearbyPlace[]
  /** The per-night price in minor units as a decimal string, or `null` when the supplier gave none. */
  pricePerNightMinor: string | null
  /**
   * Kilometres from the destination place's own centre (`Place.center`), computed by the AGENT
   * after the search — the adapter has no idea which city was searched for, only what came back.
   * `null` when either end is unknown.
   */
  distanceKm: number | null
}

/**
 * A `HotelDetail` from the four things every stay has, with every field the hotels pass added
 * defaulted to "nothing known".
 *
 * Why a factory rather than making the new fields optional: `HotelDetail` is what the corpus
 * stores and what every card, filter and gate reads, and an optional field is one a future
 * adapter can forget to populate while the compiler says nothing. A required field plus one
 * documented place listing the "nothing known" value means `SearchApiHotels` must still answer
 * for all twelve of them, while the mock supplier, the drift monitor's golden fixtures and the
 * tests stay one line each.
 *
 * Deliberately NOT used by `src/supplier/searchapi.ts`: the real adapter writes every field out
 * explicitly, because the mapping from a supplier's JSON is exactly what its tests pin.
 */
export function hotelDetail(
  core: Pick<HotelDetail, 'checkIn' | 'checkOut' | 'nights'> & Partial<HotelDetail>,
): HotelDetail {
  return {
    kind: 'hotel',
    rating: null,
    coordinates: null,
    offerSource: null,
    propertyType: 'other',
    stars: null,
    reviews: null,
    locationRating: null,
    images: [],
    amenities: [],
    essentials: [],
    nearby: [],
    pricePerNightMinor: null,
    distanceKm: null,
    ...core,
  }
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
  /** `hotels in Tokyo, Japan` — built by `hotelQuery` (src/intake/places.ts); see it for why. */
  query: string
  checkIn: string; checkOut: string
  adults: number
  currency: string
  /**
   * ISO 3166-1 alpha-2 for the destination's country, which the adapter sends as `gl` (the
   * market Google searches in). Verified live on 2026-10-04: without `gl=jp` a Tokyo query comes
   * back with US vacation rentals. `null` for a destination whose country this office does not
   * know, and the adapter then sends no `gl` at all rather than guessing a market.
   */
  countryCode: string | null
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
 * Nullable because the `search_params` column's own default is `'{}'::jsonb`
 * — a legitimate value for a row written by something other than
 * `recordResults` (a manual seed, a future bypass insert, a restore), and not
 * a real search. An empty object is not a search, and the cashier must be
 * able to tell "no search recorded" from "a search with no filters" rather
 * than re-quoting against a fabricated one.
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
  /**
   * Server-built, host-checked, tracking-ref-embedded booking link for one
   * item. See `src/supplier/urls.ts` for the shared checks and why Kiwi and
   * SearchApi apply different host rules.
   */
  bookingUrl(item: SupplierItem, trackingRef: string): string
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
