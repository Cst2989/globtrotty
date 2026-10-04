/**
 * Section 7's vocabulary and arithmetic: the fixed sentences a verdict chip can carry, and the
 * facts about one item that line up with what she asked for.
 *
 * A module of its own, imported by BOTH `src/intake/rank.ts` (which asks Jev the questions) and
 * `src/results.ts` (which re-checks every string at the `results` row boundary). Keeping it here
 * is what stops the schema from having to import the Jev client to validate a chip.
 */
import type { TripBrief } from './brief.js'
import type { SupplierItem } from '../supplier/types.js'

/**
 * Above this, a Noul answer counts as a finding. Deliberately high and deliberately not the
 * `NOUL_GATE` of 0.6 intake uses: intake's question is "did she say this?", where a near-miss
 * costs her one clarifying click, and this one's is "is this result wrong for her?", where a
 * near-miss hides an option she can actually book behind a collapsed section. The asymmetry is
 * the reason for the number.
 */
export const ISSUE_GATE = 0.7

/**
 * Every string that can end up in `matches` or `issues`, written here and nowhere else.
 *
 * The whole point of the fixed vocabulary: Jev answers a yes/no question and CODE picks the
 * sentence. Neither a model nor a supplier ever authors a word of what she reads on a chip, so
 * there is no path from a property's own description into a line of UI that looks like this
 * office's own judgment. `ResultsContentSchema` (src/results.ts) re-checks membership at the
 * boundary, so a future caller cannot smuggle a string in either.
 */
export const ISSUE_LABELS = {
  violates_cabin: 'Not the cabin you asked for',
  misses_arrival: 'Arrives after your date',
  too_many_stops: 'More stops than you wanted',
  self_transfer_risk: 'Self-transfer risk',
  wrong_type: 'A rental, not a hotel',
  far_from_centre: 'Far from the centre',
  cannot_cover_stay: 'Does not cover your dates',
} as const

export type IssueKey = keyof typeof ISSUE_LABELS

/** The fixed half of the match vocabulary; the other half is the `Lands D Mon` line below. */
export const MATCH_LABELS = [
  'Economy', 'Premium economy', 'Business', 'First',
  'Direct', '1 stop', '2 stops',
  'Hotel', 'Near the centre', 'Well rated', 'Covers your dates',
] as const

const CABIN_MATCH: Record<TripBrief['cabinLong'], string> = {
  economy: 'Economy',
  premium_economy: 'Premium economy',
  business: 'Business',
  first: 'First',
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'Lands 20 Nov' — built from the BRIEF's own ISO date, never from a supplier's string. */
export function landsLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `Lands ${d} ${MONTH_ABBR[m - 1]}`
}

/** `true` for a string this module could have produced — `ResultsContentSchema`'s own check. */
export function isKnownVerdictLabel(s: string): boolean {
  if ((MATCH_LABELS as readonly string[]).includes(s)) return true
  if (Object.values(ISSUE_LABELS).includes(s as never)) return true
  // The day is bounded 1-31, not merely "one or two digits": this is the one verdict string
  // carrying a value rather than being one, and a bound that admits "Lands 32 Nov" is not a
  // vocabulary check, it is a shape check wearing one.
  return /^Lands (3[01]|[12]\d|[1-9]) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(s)
}

export type Verdict = { matches: string[]; issues: string[] }

/** Past this many kilometres a stay is far enough out for the question to be worth asking at all. */
export const FAR_FROM_CENTRE_KM = 8

/** Within this many kilometres a stay earns the `Near the centre` chip. */
const NEAR_CENTRE_KM = 3

/** A stay has to be rated at least this well to earn `Well rated`. */
const WELL_RATED = 4

/**
 * The FACTS about one item that line up with what she asked for, computed here in code — never
 * asked of Jev.
 *
 * The division of labour is the point: a fact ("this is premium economy", "this lands on the
 * 20th", "this is 2.4 km out") is arithmetic, and arithmetic does not need a model. Jev is asked
 * only the judgment calls, which is where the issues come from. Anything a chip claims is
 * therefore reproducible from the corpus row it was computed off.
 */
export function matchesFor(kind: 'flight' | 'hotel', brief: TripBrief, item: SupplierItem): string[] {
  const out: string[] = []
  if (kind === 'flight' && item.detail.kind === 'flight') {
    const d = item.detail
    if (d.outbound.cabinClass === KIWI_CABIN_FOR[brief.cabinLong]) out.push(CABIN_MATCH[brief.cabinLong])
    if (brief.arriveBy) out.push(landsLabel(d.outbound.arrivalLocal.slice(0, 10)))
    const stops = Math.max(d.outbound.stops, d.inbound?.stops ?? 0)
    if (brief.maxStops === null || stops <= brief.maxStops) {
      if (stops === 0) out.push('Direct')
      else if (stops === 1) out.push('1 stop')
      else if (stops === 2) out.push('2 stops')
    }
    return out
  }
  if (item.detail.kind !== 'hotel') return out
  const d = item.detail
  if (d.propertyType === 'hotel') out.push('Hotel')
  if (d.distanceKm !== null && d.distanceKm <= NEAR_CENTRE_KM) out.push('Near the centre')
  if (d.rating !== null && d.rating >= WELL_RATED) out.push('Well rated')
  if (d.checkIn === brief.outbound && d.checkOut === brief.inbound) out.push('Covers your dates')
  return out
}

/**
 * `TripBrief`'s cabin vocabulary in Kiwi's own spelling — the same mapping `kiwiCabin`
 * (src/agents/intake.ts) applies on the way OUT to the supplier, applied here on the way back to
 * compare what came back against what was asked for. Duplicated rather than imported: this module
 * is imported by `src/agents/intake.ts` itself, and reaching back would be a cycle.
 */
const KIWI_CABIN_FOR: Record<TripBrief['cabinLong'], string> = {
  economy: 'Economy',
  premium_economy: 'PremiumEconomy',
  business: 'Business',
  first: 'First',
}
