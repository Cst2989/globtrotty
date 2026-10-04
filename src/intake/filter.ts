import type { Filter } from '../results.js'
import { isFlight, type StoredItem } from '../supplier/types.js'
import { maskUntrustedText } from '../sanitize.js'
import { amenityLabel, hasAmenity } from './amenities.js'
import { NEAR_CENTRE_KM } from './verdicts.js'

/** The hour-of-day (local, naive) a leg's `departureLocal` string names — 'YYYY-MM-DDTHH:MM:SS'. */
function departureHour(local: string): number {
  return Number(local.slice(11, 13))
}

function inWindow(hour: number, window: NonNullable<Filter['departure']>): boolean {
  if (window === 'morning') return hour < 12
  if (window === 'afternoon') return hour >= 12 && hour < 18
  return hour >= 18 // 'evening'
}

/**
 * Pure, over `StoredItem[]` already rehydrated from the corpus (src/repo/toolResults.ts) — the
 * router's `filter` intent (src/agents/router.ts) is the one caller, and it never re-searches: a
 * typed filter is "instant" per spec §2.2 because this never leaves the process.
 *
 * `nonstop`: BOTH legs (outbound, and inbound when the item has one) must be `stops === 0`.
 * `maxStops`: both legs must be at or under it — the same "every leg" rule as `nonstop`, which is
 * just `maxStops = 0` restated. `departure`: the OUTBOUND leg's local departure hour only, per the
 * brief — a returning evening flight does not disqualify a morning outbound one. `maxPriceMinor`:
 * the item's own total price (`price.minor`, already the party total — see `itemTotal`'s doc
 * comment in src/supplier/types.ts for why no multiplication belongs here either). `airlines`:
 * ANY leg's carrier list intersecting the filter's list keeps the item.
 *
 * `minCabinBags`/`minCheckedBags`: the fare's own included allowance (`detail.baggage`) must be
 * at least that many. `minRating`: a stay's own rating must be at least that, and a stay with NO
 * rating is excluded — "4 stars and up" is a claim about the place, and an unrated one has not
 * made it. (Results UI pass 2, D; `web/filters.ts` mirrors all three.)
 *
 * A hotel item (`detail.kind !== 'flight'`) has none of `nonstop`/`maxStops`/`departure`/
 * `airlines`/`minCabinBags`/`minCheckedBags` to check — those filters pass it through untouched —
 * but `maxPriceMinor` still applies; price is the one dimension both kinds share. `minRating`
 * runs the other way round: nothing about a flight answers it, so a flight passes it untouched.
 */
export function applyFilter(items: StoredItem[], f: Filter): StoredItem[] {
  return items.filter((item) => {
    if (f.maxPriceMinor !== undefined && item.price.minor > BigInt(f.maxPriceMinor)) return false

    if (!isFlight(item)) {
      if (item.detail.kind !== 'hotel') return true
      const d = item.detail
      if (f.minRating !== undefined && (d.rating === null || d.rating < f.minRating)) return false
      // Hotels pass, section 4. Each of these excludes a stay that cannot ANSWER it — an
      // unclassified property under a stars filter, a property of neither type under a type
      // filter, a stay with no distance under "near the centre" — for the same reason
      // `minRating` always has: the filter is a claim about the place, and one that has not made
      // the claim has not met it. `web/filters.ts` mirrors every line of this.
      if (f.stars !== undefined && f.stars.length > 0) {
        if (d.stars === null || !f.stars.includes(Math.round(d.stars))) return false
      }
      if (f.propertyType !== undefined && d.propertyType !== f.propertyType) return false
      if (f.amenities !== undefined && f.amenities.length > 0) {
        if (!f.amenities.every((key) => hasAmenity(d.amenities, key))) return false
      }
      if (f.nearCentre && (d.distanceKm === null || d.distanceKm > NEAR_CENTRE_KM)) return false
      return true
    }

    if (f.minCabinBags !== undefined && item.detail.baggage.cabinBag < f.minCabinBags) return false
    if (f.minCheckedBags !== undefined && item.detail.baggage.checkedBag < f.minCheckedBags) return false

    const legs = item.detail.inbound ? [item.detail.outbound, item.detail.inbound] : [item.detail.outbound]

    if (f.nonstop && legs.some((leg) => leg.stops !== 0)) return false
    if (f.maxStops !== undefined && legs.some((leg) => leg.stops > f.maxStops!)) return false
    if (f.departure && !inWindow(departureHour(item.detail.outbound.departureLocal), f.departure)) return false
    if (f.airlines && f.airlines.length > 0) {
      const carriers = new Set(legs.flatMap((leg) => leg.carriers))
      if (!f.airlines.some((a) => carriers.has(a))) return false
    }
    return true
  })
}

/** `'50000'` (minor) rendered back as a plain major-unit number, no currency symbol —
 * `Filter.maxPriceMinor` carries no currency code, so this prints a bare amount rather than guess
 * one. */
function minorToMajor(minorStr: string): string {
  const n = Number(BigInt(minorStr)) / 100
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * The fixed line the router's `filter` step replies with (`Showing ${n} of ${total}:
 * ${describeFilter(f)}.`) — built only from `Filter`'s own enums/numbers and, for `airlines`,
 * carrier codes that came from the corpus (supplier-origin, same trust class as any other
 * tool-result string) — hence `maskUntrustedText` on each one, same instinct as every other
 * supplier string this repo renders.
 */
export function describeFilter(f: Filter): string {
  const parts: string[] = []
  if (f.nonstop) parts.push('nonstop')
  if (f.maxStops !== undefined && !f.nonstop) {
    parts.push(f.maxStops === 0 ? 'nonstop' : `up to ${f.maxStops} stop${f.maxStops === 1 ? '' : 's'}`)
  }
  if (f.departure) parts.push(f.departure)
  if (f.maxPriceMinor !== undefined) parts.push(`under ${minorToMajor(f.maxPriceMinor)}`)
  if (f.minCabinBags !== undefined && f.minCabinBags > 0) {
    parts.push(f.minCabinBags === 1 ? 'with a cabin bag' : `with ${f.minCabinBags} cabin bags`)
  }
  if (f.minCheckedBags !== undefined && f.minCheckedBags > 0) {
    parts.push(f.minCheckedBags === 1 ? 'with a checked bag' : `with ${f.minCheckedBags} checked bags`)
  }
  if (f.minRating !== undefined && f.minRating > 0) parts.push(`rated ${f.minRating}+`)
  if (f.stars !== undefined && f.stars.length > 0) {
    parts.push(`${[...f.stars].sort((a, b) => a - b).join(', ')} star`)
  }
  if (f.propertyType !== undefined) parts.push(f.propertyType === 'hotel' ? 'hotels only' : 'rentals only')
  // The amenity KEY never reaches her — `amenityLabel` is this office's own word for it, and the
  // key is an internal identifier that happens to look like English.
  if (f.amenities !== undefined && f.amenities.length > 0) {
    parts.push(f.amenities.map(amenityLabel).join(', ').toLowerCase())
  }
  if (f.nearCentre) parts.push('near the centre')
  if (f.airlines && f.airlines.length > 0) parts.push(f.airlines.map(maskUntrustedText).join(', '))
  return parts.length > 0 ? parts.join(', ') : 'all results'
}
