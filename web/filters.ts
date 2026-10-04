import type { Filter } from '@/src/results'
import type { ResultItemLite } from '@/web/data'
import { hasAmenity } from '@/src/intake/amenities'
import { NEAR_CENTRE_KM } from '@/src/intake/verdicts'
import { avoidRegionLabel, regionOfCountry, type AvoidRegion } from '@/src/intake/regions'

/**
 * Client-side filter application over the lite result shape (`ResultItemLite`,
 * `web/data.ts`) — spec §2.2: "They filter client-side over the stored
 * results, no turn." Same `Filter` type (src/results.ts) a `results` row's
 * own `filter` field carries, so a filter chosen here is exactly what gets
 * written back by the typed-message `filter` intent (src/agents/filter.ts,
 * a concurrent task) when she types a change instead of clicking a chip —
 * this module does not import that one (a different task, in flight), so the
 * boundary definitions below (morning/afternoon/evening) are this module's
 * own and are documented at `inWindow` for easy reconciliation later.
 *
 * Every flight-specific field (`nonstop`, `maxStops`, `departure`,
 * `airlines`) only ever excludes a FLIGHT item (one with `.flight` set); a
 * hotel item has no leg to judge those against, so it passes through
 * unaffected. `maxPriceMinor` applies to both kinds — it compares the
 * item's own total price, not anything inside `.flight`/`.hotel`.
 *
 * `minCabinBags`/`minCheckedBags` read the fare's own included allowance; `minRating` is the
 * hotel-only mirror of the same idea (results UI pass 2, D).
 *
 * This module MIRRORS `src/intake/filter.ts` field for field, and the
 * ledger's deferred reconciliation is now closed on both: the departure
 * windows (Task 10) and the stops rule (the final review's I3 — every leg,
 * see `worstLegStops`). `test/web-filters.test.ts` pins the two modules
 * against the same items for both. A change to either rule belongs in both
 * files, in the same commit.
 */
export function applyFilterLite(items: ResultItemLite[], filter: Filter): ResultItemLite[] {
  return items.filter((item) => matchesFilter(item, filter))
}

function matchesFilter(item: ResultItemLite, filter: Filter): boolean {
  if (filter.maxPriceMinor !== undefined && BigInt(item.priceMinor) > BigInt(filter.maxPriceMinor)) {
    return false
  }

  const flight = item.flight
  if (!flight) {
    // The hotel-only half, mirroring `src/intake/filter.ts` line for line. Every one of these
    // excludes a stay that cannot ANSWER it — an unrated or unclassified property, a property of
    // neither type, a stay with no distance — because the filter is a claim about the place and
    // one that has not made the claim has not met it.
    const hotel = item.hotel
    if (!hotel) return true
    if (filter.minRating !== undefined && (hotel.rating === null || hotel.rating < filter.minRating)) {
      return false
    }
    if (filter.stars !== undefined && filter.stars.length > 0) {
      if (hotel.stars === null || !filter.stars.includes(Math.round(hotel.stars))) return false
    }
    if (filter.propertyType !== undefined && hotel.propertyType !== filter.propertyType) return false
    if (filter.amenities !== undefined && filter.amenities.length > 0) {
      if (!filter.amenities.every((key) => hasAmenity(hotel.amenities, key))) return false
    }
    if (filter.nearCentre && (hotel.distanceKm === null || hotel.distanceKm > NEAR_CENTRE_KM)) {
      return false
    }
    return true // nothing else below applies to a hotel item
  }

  if (filter.minCabinBags !== undefined && flight.bags.cabin < filter.minCabinBags) return false
  if (filter.minCheckedBags !== undefined && flight.bags.checked < filter.minCheckedBags) return false

  const stops = worstLegStops(flight)
  if (filter.nonstop && stops !== 0) return false
  if (filter.maxStops !== undefined && stops > filter.maxStops) return false

  if (filter.departure) {
    const hour = departureHour(flight.outbound.departureLocal)
    if (hour === null || !inWindow(hour, filter.departure)) return false
  }

  if (filter.airlines && filter.airlines.length > 0) {
    if (!flight.airlines.some((a) => filter.airlines!.includes(a))) return false
  }

  if ((filter.avoidCountries && filter.avoidCountries.length > 0) || (filter.avoidRegions && filter.avoidRegions.length > 0)) {
    const legs = flight.inbound ? [flight.outbound, flight.inbound] : [flight.outbound]
    const avoided = legs.some((leg) => leg.viaCountries.some((code) => {
      if (code === null) return false
      if (filter.avoidCountries?.includes(code)) return true
      const region = regionOfCountry(code)
      return region !== null && (filter.avoidRegions?.includes(region) ?? false)
    }))
    if (avoided) return false
  }

  return true
}

/**
 * The stops of the WORSE leg — `src/intake/filter.ts`'s rule stated for the
 * lite shape: "`nonstop`: BOTH legs (outbound, and inbound when the item has
 * one) must be `stops === 0`. `maxStops`: both legs must be at or under it."
 *
 * The final review's I3. `ResultItemLite.flight.stops` is the OUTBOUND leg
 * alone (it is what `FlightList` prints beside `outbound.via`), so judging
 * `nonstop` on it let through a flight whose RETURN leg has two stops —
 * which typing "only direct flights" then removed. Same ids, two answers.
 * A one-way (`inboundStops === null`) has only the one leg to judge.
 */
export function worstLegStops(flight: NonNullable<ResultItemLite['flight']>): number {
  return flight.inboundStops === null ? flight.stops : Math.max(flight.stops, flight.inboundStops)
}

/**
 * Reads the hour straight off the naive ISO string (no timezone, no `Date`
 * parsing) — the same instinct `web/data.ts`'s `datesFromDetail` documents
 * for `departureLocal`: this is a naive local time, and parsing it into a
 * `Date` would silently apply whatever offset the running environment
 * happens to have. `null` when the string does not carry a recognisable
 * `T\d{2}:` hour (never thrown).
 */
function departureHour(departureLocal: string): number | null {
  const m = /T(\d{2}):/.exec(departureLocal)
  return m ? Number(m[1]) : null
}

/**
 * Boundaries this module owns, reconciled (Task 10) with
 * `src/intake/filter.ts`'s own `inWindow` so a chip clicked here and a typed
 * filter resolved there never disagree on the same outbound hour: morning
 * < 12:00, afternoon 12:00–17:59, evening >= 18:00.
 * `test/web-filters.test.ts`'s "departure window reconciliation" block pins
 * both modules against the same three hours.
 */
function inWindow(hour: number, window: 'morning' | 'afternoon' | 'evening'): boolean {
  if (window === 'morning') return hour < 12
  if (window === 'afternoon') return hour >= 12 && hour < 18
  return hour >= 18
}

/** The `[min, max]` of `priceMinor` across `items`, as bigints — `{ min: 0n, max: 0n }` for an empty list. */
export function priceRange(items: ResultItemLite[]): { min: bigint; max: bigint } {
  if (items.length === 0) return { min: 0n, max: 0n }
  let min = BigInt(items[0]!.priceMinor)
  let max = min
  for (const item of items) {
    const p = BigInt(item.priceMinor)
    if (p < min) min = p
    if (p > max) max = p
  }
  return { min, max }
}

/**
 * How the list is ordered. `best` is the order the `results` row itself stores — Jev's own
 * re-rank (src/intake/rank.ts), which is the only one of the three that knows anything about the
 * brief — so it is the default and it is deliberately NOT a sort at all.
 */
export type Sort = 'best' | 'cheapest' | 'fastest' | 'rated'

/**
 * `items`, reordered. Never mutates its argument; `best` returns a copy in the stored order so
 * every caller can treat the result the same way.
 *
 * `fastest` reads `flight.durationMinutes`, the WHOLE itinerary's duration as the supplier gave
 * it — not the per-leg figures, which for a return trip are naive-local differences carrying a
 * timezone skew (see `LegLite.durationMinutes`). An item with no flight payload sorts as
 * duration 0; a hotel list never offers this tab.
 *
 * Ties keep their stored order: `Array.prototype.sort` is stable, so two identically priced
 * flights stay in Jev's own order relative to each other, which is the most useful tiebreak
 * available and the least surprising.
 */
export function sortItemsLite(items: ResultItemLite[], sort: Sort): ResultItemLite[] {
  const copy = [...items]
  if (sort === 'cheapest') {
    return copy.sort((a, b) => {
      const pa = BigInt(a.priceMinor)
      const pb = BigInt(b.priceMinor)
      return pa < pb ? -1 : pa > pb ? 1 : 0
    })
  }
  if (sort === 'fastest') {
    return copy.sort((a, b) => (a.flight?.durationMinutes ?? 0) - (b.flight?.durationMinutes ?? 0))
  }
  if (sort === 'rated') {
    // Highest first, and an UNRATED stay sorts last rather than as a zero — it has not been
    // rated badly, it has not been rated. A flight list never offers this tab.
    return copy.sort((a, b) => (b.hotel?.rating ?? -1) - (a.hotel?.rating ?? -1))
  }
  return copy
}

/** The first item each sort would put at the top — what a sort tab shows as its own summary. */
export function leadersBySort(items: ResultItemLite[], sorts: Sort[]): Map<Sort, ResultItemLite | null> {
  return new Map(sorts.map((sort) => [sort, sortItemsLite(items, sort)[0] ?? null]))
}

/** The count of items in `items` whose flight lists `code` as a carrier — the rail's airline counts. */
export function airlineCounts(items: ResultItemLite[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const code of item.flight?.airlines ?? []) counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return counts
}

/** Carrier code -> the airline's name, as `web/data.ts` resolved it; code as its own fallback. */
export function airlineNamesOf(items: ResultItemLite[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const item of items) {
    const flight = item.flight
    if (!flight) continue
    flight.airlines.forEach((code, i) => {
      if (!names.has(code)) names.set(code, flight.airlineNames[i] ?? code)
    })
  }
  return names
}

/** True when `filter` narrows anything at all — what the rail's "Clear filters" link keys on. */
export function isFilterSet(filter: Filter): boolean {
  return Object.values(filter).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined))
}

/**
 * The regions and countries actually worth offering in the Connections popover: every one that
 * shows up among `items`' own via airports, each with how many items would be affected by
 * avoiding it — never the full ten-region/130-country vocabulary, which would mostly be
 * checkboxes for places nothing in this list connects through. Counted per ITEM (an item with
 * two stops in the same country counts once), same instinct as `airlineCounts`.
 *
 * Both lists are sorted by that count, descending, then alphabetically — the regions/countries
 * she is most likely to actually want to avoid come first.
 */
export function connectionsPresent(items: ResultItemLite[]): {
  regions: { region: AvoidRegion; label: string; count: number }[]
  countries: { code: string; name: string; count: number }[]
} {
  const regionCounts = new Map<AvoidRegion, number>()
  const countryCounts = new Map<string, number>()
  const countryNames = new Map<string, string>()

  for (const item of items) {
    const flight = item.flight
    if (!flight) continue
    const legs = flight.inbound ? [flight.outbound, flight.inbound] : [flight.outbound]
    const codes = new Set<string>()
    const regions = new Set<AvoidRegion>()
    for (const leg of legs) {
      leg.viaCountries.forEach((code, i) => {
        if (code === null) return
        codes.add(code)
        if (!countryNames.has(code)) countryNames.set(code, leg.viaCountryNames[i] ?? code)
        const region = regionOfCountry(code)
        if (region !== null) regions.add(region)
      })
    }
    for (const code of codes) countryCounts.set(code, (countryCounts.get(code) ?? 0) + 1)
    for (const region of regions) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1)
  }

  const regions = [...regionCounts.entries()]
    .map(([region, count]) => ({ region, label: avoidRegionLabel(region), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const countries = [...countryCounts.entries()]
    .map(([code, count]) => ({ code, name: countryNames.get(code) ?? code, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return { regions, countries }
}
