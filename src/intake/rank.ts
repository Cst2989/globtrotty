/**
 * The re-rank: one Jev call that scores the first page of a direct supplier search against the
 * brief's own preferences, so the results row she sees is ordered by fit rather than by whatever
 * order the supplier happened to return. Jev never sees a sourceId or an airline's real name
 * unmasked — only the enum-like summary `summary()` below builds, same trust-boundary instinct as
 * the rest of this module (src/intake/brief.ts's doc comment).
 */
import { askJev, scoreQ, type JevDeps, type JevQuestion, type JevRequest, type JevResponse } from '../jev/client.js'
import { minorUnitExponent } from '../money.js'
import { maskUntrustedText } from '../sanitize.js'
import type { TripBrief } from './brief.js'
import type { SupplierItem } from '../supplier/types.js'

/** At most this many options are sent to Jev for scoring — `o0`..`o19`. */
const MAX_SCORED = 20

const SCORE_LEVELS = ['Violates a stated preference', 'Acceptable', 'Good fit', 'Best possible fit']

/**
 * Kiwi's own cabin vocabulary (src/supplier/kiwi.ts echoes `cabinClass` back on every leg as a
 * raw string). A value outside this set is not trusted enum-like data — it could be anything a
 * compromised or buggy upstream decided to put there — so it never reaches Jev's state at all;
 * `'unknown'` stands in for it instead of the raw string.
 */
const KNOWN_KIWI_CABINS = new Set(['Economy', 'PremiumEconomy', 'Business', 'First'])

/**
 * Numbers and enum-like strings only — never a sourceId, never an unmasked supplier-origin
 * string. `stops` takes the WORSE of the two legs (a round trip that is nonstop out and two-stop
 * back is not a nonstop round trip); `bags`/`selfTransfer` are already whole-item properties, not
 * per-leg, so there is nothing to combine. `departLocal`/`arriveLocal` describe the outbound leg,
 * the one her preferences (`arriveBy`, cabin) are stated against.
 *
 * Fix round 1: `cabinClass`, `departureLocal` and `arrivalLocal` are every bit as supplier-origin
 * as the airline names already masked below — a review found them passing through unmasked,
 * which is exactly the prompt-injection surface `maskUntrustedText` exists to close. `cabin` gets
 * the STRONGER treatment (validate against a known vocabulary, not just mask) because it is meant
 * to be a pure enum; masking an unexpected value would still hand Jev a string it has never seen
 * and has no reason to trust, where `'unknown'` is an honest answer that fits the vocabulary Jev
 * is actually asked to reason over.
 */
function flightSummary(item: SupplierItem) {
  if (item.detail.kind !== 'flight') throw new TypeError('flightSummary: flight items only')
  const d = item.detail
  const exp = minorUnitExponent(item.price.currency)
  return {
    price: Number(item.price.minor) / 10 ** exp,
    airlines: d.outbound.carriers.map(maskUntrustedText),
    stops: Math.max(d.outbound.stops, d.inbound?.stops ?? 0),
    departLocal: maskUntrustedText(d.outbound.departureLocal),
    arriveLocal: maskUntrustedText(d.outbound.arrivalLocal),
    durationHours: Math.round((d.totalDurationSeconds / 3600) * 10) / 10,
    cabin: KNOWN_KIWI_CABINS.has(d.outbound.cabinClass) ? d.outbound.cabinClass : 'unknown',
    selfTransfer: d.selfTransfer,
    bags: d.baggage.checkedBag,
  }
}

/**
 * The hotels pass's own summary, the same shape of thing as `flightSummary`: numbers and
 * enum-like values only, every supplier-authored string already masked at the adapter boundary
 * (src/supplier/searchapi.ts's `maskLabel`) before it ever reached the corpus.
 *
 * `amenityCount` rather than the amenity labels themselves is deliberate. The labels are
 * supplier text, they vary ("Free Wi-Fi", "Kitchen in some rooms", "Paid parking"), and what Jev
 * is being asked is how well a stay fits a stated preference — a count answers "how equipped is
 * it" without handing twenty strings per option to a model that would then be reasoning over
 * Google's vocabulary rather than hers.
 */
function hotelSummary(item: SupplierItem) {
  if (item.detail.kind !== 'hotel') throw new TypeError('hotelSummary: hotel items only')
  const d = item.detail
  const exp = minorUnitExponent(item.price.currency)
  return {
    price: Number(item.price.minor) / 10 ** exp,
    type: d.propertyType,
    stars: d.stars,
    rating: d.rating,
    reviews: d.reviews,
    distanceKm: d.distanceKm,
    amenityCount: d.amenities.length,
    nights: d.nights,
  }
}

/** One search's items are all one kind; the first one says which. */
function kindOf(items: SupplierItem[]): 'flight' | 'hotel' {
  return items[0]?.detail.kind === 'hotel' ? 'hotel' : 'flight'
}

/**
 * The slice of the brief Jev is asked to weigh against, per kind.
 *
 * The flight preferences are the six fields `briefForRank` (src/agents/refresh.ts) documents as
 * recoverable from a stored row. The hotel ones are the three a stay can actually be judged
 * against: the party size and the window, plus the fact that the search itself asked for hotels
 * (`hotels in Tokyo, Japan` — see `hotelQuery` in src/intake/places.ts), which is what makes a
 * vacation rental in the results a worse fit than a hotel rather than merely a different one.
 *
 * `TripBrief.hotels` is deliberately NOT here. It answers "does she want accommodation arranged
 * too?" (src/intake/brief.ts's `hotels_wanted`), which is a question about whether to search at
 * all, not about which stay fits best — and by the time this runs, the search has happened.
 * Nothing about `cabinLong` or `maxStops` means anything to a building either.
 */
function preferencesFor(kind: 'flight' | 'hotel', brief: TripBrief) {
  if (kind === 'hotel') {
    return {
      searchedFor: 'hotels', adults: brief.adults,
      checkIn: brief.outbound, checkOut: brief.inbound,
    }
  }
  return {
    cabinLong: brief.cabinLong, cabinShort: brief.cabinShort, maxStops: brief.maxStops,
    arriveBy: brief.arriveBy, outbound: brief.outbound, inbound: brief.inbound,
  }
}

/**
 * Orders `items` by Jev's fit score (desc), then price (asc) as the tiebreak. Only the first
 * `MAX_SCORED` items are ever sent to Jev — any remainder is kept, in its original relative
 * order, after the scored-and-sorted head. Throws whatever `askJev` throws (a `JevError`): the
 * caller (src/agents/intake.ts) decides what a re-rank failure means for the turn.
 *
 * Both kinds go through this one function: a flight itinerary and a stay are scored by the same
 * question against the same four levels, over the summary their own kind supplies. The hotels
 * pass added the hotel half — `handleChooseFlight` used to show whatever order SearchApi
 * happened to return, which for a 16-night Tokyo window is six vacation rentals before the first
 * hotel she would actually book.
 */
export async function rankItems(
  deps: { jev: JevDeps }, brief: TripBrief, items: SupplierItem[],
): Promise<{ ordered: SupplierItem[]; request: JevRequest; response: JevResponse }> {
  const scored = items.slice(0, MAX_SCORED)
  const rest = items.slice(MAX_SCORED)
  const kind = kindOf(scored)

  const options = scored.map((item, index) => ({
    id: index, ...(kind === 'hotel' ? hotelSummary(item) : flightSummary(item)),
  }))
  const state = { preferences: preferencesFor(kind, brief), options }

  const questions: Record<string, JevQuestion> = {}
  for (let i = 0; i < scored.length; i++) {
    questions[`o${i}`] = scoreQ(`How well does option o${i} match her preferences?`, SCORE_LEVELS)
  }

  const request: JevRequest = { state, questions }
  const response = await askJev(deps.jev, request)

  const withScores = scored.map((item, index) => {
    const answer = response.answers[`o${index}`]
    const score = answer?.type === 'score' ? answer.score : 0
    return { item, score }
  })
  withScores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Same currency within one search (one `FlightSearch.currency`), so comparing minor units
    // directly is safe — no cross-currency arithmetic, which `compareMoney` would refuse anyway.
    return Number(a.item.price.minor - b.item.price.minor)
  })

  return { ordered: [...withScores.map((w) => w.item), ...rest], request, response }
}
