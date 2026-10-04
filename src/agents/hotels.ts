/**
 * What `handleChooseFlight` (src/agents/choose.ts) and `handleRefresh` (src/agents/refresh.ts)
 * both need to run a hotel search, in one place so the two can never disagree about it. They
 * disagreed before the hotels pass: `handleChooseFlight` built the supplier query from the
 * ARRIVAL AIRPORT code and `handleRefresh` rebuilt it from the stored row's display name, so a
 * refresh searched for something subtly different from the search it was refreshing.
 *
 * Trust boundary: every string here comes from this repo's own bundled tables (`places.json`,
 * `countries.json`) — never from a supplier's response and never from her typed message.
 */
import { addDays } from '../intake/dates.js'
import { haversineKm, hotelQuery, placeForCode, type Place } from '../intake/places.js'
import type { FlightDetail, HotelSearch, SupplierItem } from '../supplier/types.js'

/**
 * The destination and the window a CHOSEN FLIGHT implies: check-in is the outbound leg's own
 * arrival date, check-out the inbound leg's own departure date (or seven nights for a one-way).
 * `null` when the arrival airport is one the bundled place table cannot name a city for.
 *
 * Polish pass, section 2. This used to live inside `handleChooseFlight` alone, so `handleRefresh`
 * had no way to ask the same question and rebuilt the stay search out of the stored `results`
 * row instead. A row written before the airport-to-metro fix says `NRT`, and SearchApi answers
 * "NRT" with vacation rentals in the United States — so a refresh could replace a list of Tokyo
 * hotels with the exact bug the previous pass removed. One function, both callers.
 *
 * The airport-to-metro step is the load-bearing one: a chosen flight names an AIRPORT ("NRT")
 * and the place table is keyed on METROS ("TYO").
 */
export function stayWindowForFlight(
  detail: FlightDetail,
): { place: Place; checkIn: string; checkOut: string } | null {
  const place = placeForCode(detail.outbound.to)
  if (place === null) return null
  const checkIn = detail.outbound.arrivalLocal.slice(0, 10)
  const checkOut = detail.inbound ? detail.inbound.departureLocal.slice(0, 10) : addDays(checkIn, 7)
  return { place, checkIn, checkOut }
}

/**
 * The `HotelSearch` for one destination place and window.
 *
 * `query` is `hotels in Tokyo, Japan` and `countryCode` becomes the adapter's `gl` — see
 * `hotelQuery` and `HotelSearch.countryCode` for the live evidence that both are load-bearing.
 */
export function hotelSearchFor(args: {
  place: Place
  checkIn: string
  checkOut: string
  adults: number
  currency: string
}): HotelSearch {
  return {
    kind: 'hotel',
    query: hotelQuery(args.place.hotelName, args.place.country),
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    adults: args.adults,
    currency: args.currency,
    countryCode: args.place.country,
  }
}

/**
 * The same items with `detail.distanceKm` filled in from the destination's own centre.
 *
 * Computed HERE rather than in the adapter because the adapter knows what came back, not what
 * was searched for — a supplier response carries no "and this is the city you asked about". A
 * stay whose own coordinates are missing, or a place with no geocoded centre, keeps `null`: the
 * card then prints no distance at all, which is the only honest option. Never mutates its
 * argument.
 */
export function withDistanceFromCentre(items: SupplierItem[], place: Place): SupplierItem[] {
  const centre = place.center
  return items.map((item) => {
    if (item.detail.kind !== 'hotel') return item
    const coordinates = item.detail.coordinates
    const distanceKm = centre !== null && coordinates !== null ? haversineKm(centre, coordinates) : null
    return { ...item, detail: { ...item.detail, distanceKm } }
  })
}
