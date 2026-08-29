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

export type SupplierCapabilities = {
  live: boolean
  mayRequote: boolean
  maxAgeSeconds: number
  pricePersistence: 'none' | 'session' | '24h' | 'indefinite'
}

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
 * `quantity` is a count of identical units (3 seats, 7 nights), so this is
 * integer multiplication in minor units and never a float multiply. A
 * non-integer quantity is a caller bug, not a rounding question — there is no
 * correct way to charge 1.5 of a seat, so it throws rather than picking one.
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
