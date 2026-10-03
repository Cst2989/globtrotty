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
 * Numbers and enum-like strings only — never a sourceId, never an unmasked airline name. `stops`
 * takes the WORSE of the two legs (a round trip that is nonstop out and two-stop back is not a
 * nonstop round trip); `bags`/`selfTransfer` are already whole-item properties, not per-leg, so
 * there is nothing to combine. `departLocal`/`arriveLocal` describe the outbound leg, the one her
 * preferences (`arriveBy`, cabin) are stated against.
 */
function summary(item: SupplierItem) {
  if (item.detail.kind !== 'flight') throw new TypeError('rankItems: flight items only')
  const d = item.detail
  const exp = minorUnitExponent(item.price.currency)
  return {
    price: Number(item.price.minor) / 10 ** exp,
    airlines: d.outbound.carriers.map(maskUntrustedText),
    stops: Math.max(d.outbound.stops, d.inbound?.stops ?? 0),
    departLocal: d.outbound.departureLocal,
    arriveLocal: d.outbound.arrivalLocal,
    durationHours: Math.round((d.totalDurationSeconds / 3600) * 10) / 10,
    cabin: d.outbound.cabinClass,
    selfTransfer: d.selfTransfer,
    bags: d.baggage.checkedBag,
  }
}

/**
 * Orders `items` by Jev's fit score (desc), then price (asc) as the tiebreak. Only the first
 * `MAX_SCORED` items are ever sent to Jev — any remainder is kept, in its original relative
 * order, after the scored-and-sorted head. Throws whatever `askJev` throws (a `JevError`): the
 * caller (src/agents/intake.ts) decides what a re-rank failure means for the turn.
 */
export async function rankItems(
  deps: { jev: JevDeps }, brief: TripBrief, items: SupplierItem[],
): Promise<{ ordered: SupplierItem[]; request: JevRequest; response: JevResponse }> {
  const scored = items.slice(0, MAX_SCORED)
  const rest = items.slice(MAX_SCORED)

  const options = scored.map((item, index) => ({ id: index, ...summary(item) }))
  const preferences = {
    cabinLong: brief.cabinLong, cabinShort: brief.cabinShort, maxStops: brief.maxStops,
    arriveBy: brief.arriveBy, outbound: brief.outbound, inbound: brief.inbound,
  }
  const state = { preferences, options }

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
