/**
 * The Jev "brief": one fan-out call that turns her message plus the candidates
 * `src/intake/candidates.ts` found into either a complete `TripBrief` or a clickable choice
 * card. Jev never does calendar arithmetic or looks anything up by name — it only picks among
 * the candidates and fixed vocabularies code hands it; `src/intake/dates.ts` does the math and
 * `src/intake/places.ts`'s table supplies every label a choice card shows her.
 */
import { askJev, choiceQ, noulQ, type JevAnswer, type JevDeps, type JevQuestion, type JevRequest, type JevResponse } from '../jev/client.js'
import { placeCandidates, datePartCandidates, countCandidates, type PlaceCandidate, type DateParts } from './candidates.js'
import { CODE_MAP, isLongHaul } from './places.js'
import { MONTHS, WEEKDAYS, addDays, resolveDate } from './dates.js'

export type Cabin = 'economy' | 'premium_economy' | 'business' | 'first'

export type Assumption = { field: string; value: string; reason: 'unstated' | 'defaulted' | 'year' }

export type TripBrief = {
  origin: string
  destination: string
  sideTrip: string | null
  outbound: string
  inbound: string | null
  adults: number
  cabinLong: Cabin
  cabinShort: Cabin
  maxStops: number | null
  hotels: boolean
  arriveBy: boolean
  assumptions: Assumption[]
}

/**
 * A choice card's `questionId` is one of these three — the only fields a low-confidence or
 * absent answer can turn into a clickable card this turn (ledger ruling 1). Every other field
 * (`return_*`, `party_adults`, cabins, `max_stops`) falls back to a sensible default instead,
 * recorded as an `Assumption`.
 */
export type IntakeOutcome =
  | { kind: 'brief'; brief: TripBrief }
  | { kind: 'choices'; questionId: 'origin' | 'destination' | 'outbound'; question: string; options: { id: string; label: string }[] }

export type IntakeCandidates = { places: PlaceCandidate[]; dates: DateParts; counts: number[] }

const CONFIDENCE_GATE = 0.6
const NOUL_GATE = 0.6

/** Fixed sentences for the three fields a choice card can ask about (Step 4 of the brief). */
const QUESTION_TEXT = {
  origin: 'Which city are you flying from?',
  destination: 'Where is the trip to?',
  outbound: 'Which date do you leave?',
} as const

/**
 * `buildIntakeQuestions(text, c)`'s question set verbatim. `today` is only used to offer this
 * year and next year as `outbound_year` options — the actual resolution (which year a bare
 * month/day means) is `resolveDate`'s job, not a criterion Jev chooses between.
 */
export function buildIntakeQuestions(text: string, c: IntakeCandidates, today: Date): Record<string, JevQuestion> {
  const placeCriteria = Object.fromEntries([
    ...c.places.map((p) => [p.code, `${p.city} (she wrote "${p.span}")`]),
    ['none', 'No place in the list is this'],
  ])
  const months = Object.fromEntries([...MONTHS.map((m) => [m, null]), ['unstated', 'No month is stated for this date']])
  const days = Object.fromEntries([...Array.from({ length: 31 }, (_, i) => [String(i + 1), null]), ['unstated', 'No day is stated']])
  const year = today.getUTCFullYear()
  return {
    origin: choiceQ('Which place is she travelling FROM (her home or departure city)?', placeCriteria),
    destination: choiceQ('Which place is the MAIN destination of the trip?', placeCriteria),
    side_trip: choiceQ('Which place, if any, is a SIDE TRIP from the main destination?', placeCriteria),
    outbound_month: choiceQ('The month of the OUTBOUND date (arrival or departure)', months),
    outbound_day: choiceQ('The day of the month of the OUTBOUND date (arrival or departure)', days),
    return_month: choiceQ('The month of the RETURN date', months),
    return_day: choiceQ('The day of the month of the RETURN date', days),
    outbound_year: choiceQ('The year of the outbound date', { [String(year)]: null, [String(year + 1)]: null, unstated: 'No year is stated' }),
    outbound_weekday: choiceQ('A weekday named for the outbound date', { ...WEEKDAYS, none: 'No weekday for the outbound' }),
    outbound_relative: choiceQ('How the outbound date is phrased', { absolute: 'A calendar date is named', relative: 'Relative to today, e.g. tomorrow, next Friday', none: 'No outbound date at all' }),
    party_adults: choiceQ('How many adults travel?', { '1': null, '2': 'Two, including phrases like "my wife", "the two of us"', '3': null, '4': null, '5': null, '6': null, unstated: 'Not stated' }),
    trip_type: choiceQ('Is this a return trip or one way?', { return: 'She comes back (a return date or "back" is mentioned)', one_way: 'Only an outward journey', unstated: 'Cannot tell' }),
    cabin_long: choiceQ('Cabin for the LONG flights', { economy: null, premium_economy: null, business: null, first: null, unstated: 'Not stated' }),
    cabin_short: choiceQ('Cabin for the SHORT flights', { economy: null, premium_economy: null, business: null, first: null, unstated: 'Not stated' }),
    max_stops: choiceQ('Stops she will accept', { nonstop_only: 'Direct only', one_stop_ok: 'A connection is fine or not mentioned as a problem', unstated: 'Not stated' }),
    hotels_wanted: noulQ('Does she want accommodation arranged too?'),
    arrive_by: noulQ('Is the outbound date the day she must BE THERE (an arrival deadline)? The date itself is still the outbound date.'),
    fixed_commitment: noulQ('Does she name a dated event she must attend during the trip?'),
  }
}

function choiceOf(answers: Record<string, JevAnswer>, key: string): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  const a = answers[key]
  return a && a.type === 'choice' ? a : null
}

function noulOf(answers: Record<string, JevAnswer>, key: string): number {
  const a = answers[key]
  return a && a.type === 'noul' ? a.noul : 0
}

/** A confident, actually-stated choice, or `null` when it's a sentinel ("unstated"/"none") or below the confidence gate. */
function stated(answer: { choice: string; confidence: number } | null, sentinels: readonly string[] = ['unstated', 'none']): string | null {
  if (!answer || answer.confidence < CONFIDENCE_GATE || sentinels.includes(answer.choice)) return null
  return answer.choice
}

/** Top three non-sentinel probabilities, as choice-card options labelled from the place table — never her span, never the model's words. */
function placeOptions(probabilities: Record<string, number>): { id: string; label: string }[] {
  return Object.entries(probabilities)
    .filter(([code]) => code !== 'none' && code !== 'unstated')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code]) => ({ id: code, label: CODE_MAP.get(code)?.city ?? code }))
}

/** When the outbound date itself can't be resolved, the card offers the candidate day/month combinations she actually wrote, as ISO labels. */
function dateOptions(c: IntakeCandidates, today: Date): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  for (const month of c.dates.months) {
    for (const day of c.dates.days) {
      const resolved = resolveDate({ month, day, year: null }, today)
      if (resolved && !out.some((o) => o.id === resolved.iso)) out.push({ id: resolved.iso, label: resolved.iso })
      if (out.length >= 3) return out
    }
  }
  return out
}

/**
 * Assembles a `TripBrief` from Jev's answers, or decides the turn ends in a choice card instead.
 * `outboundOverride`, when given (a re-run after she clicked an outbound date option — ledger
 * ruling 2), is used as the outbound ISO date directly, bypassing date resolution and the
 * "arrive by" day-earlier adjustment entirely: she already confirmed the exact day she leaves.
 */
export function assembleBrief(
  answers: Record<string, JevAnswer>,
  candidates: IntakeCandidates,
  today: Date,
  lastOrigin: string | null,
  outboundOverride?: string,
): IntakeOutcome {
  const assumptions: Assumption[] = []

  const originAnswer = choiceOf(answers, 'origin')
  let origin = stated(originAnswer)
  if (!origin) {
    if (lastOrigin) {
      origin = lastOrigin
      assumptions.push({ field: 'origin', value: lastOrigin, reason: 'defaulted' })
    } else {
      return { kind: 'choices', questionId: 'origin', question: QUESTION_TEXT.origin, options: placeOptions(originAnswer?.probabilities ?? {}) }
    }
  }

  const destAnswer = choiceOf(answers, 'destination')
  const destination = stated(destAnswer)
  if (!destination) {
    return { kind: 'choices', questionId: 'destination', question: QUESTION_TEXT.destination, options: placeOptions(destAnswer?.probabilities ?? {}) }
  }

  const sideRaw = stated(choiceOf(answers, 'side_trip'))
  const sideTrip = sideRaw && sideRaw !== destination ? sideRaw : null

  let outbound: string
  if (outboundOverride) {
    outbound = outboundOverride
  } else {
    const month = stated(choiceOf(answers, 'outbound_month'))
    const day = stated(choiceOf(answers, 'outbound_day'))
    const weekday = stated(choiceOf(answers, 'outbound_weekday'))
    const relative = candidates.dates.relative.includes('next') ? 'next' : null

    // `outbound_year`'s criteria only ever offers the current and next year — never a year she
    // actually typed — so a confident choice here reflects Jev's own guess at "which of these
    // two is more plausible", not something she stated. A year only counts as stated when the
    // literal 4-digit number also turned up in the code-found candidates (`datePartCandidates`);
    // otherwise `resolveDate`'s own nearest-future-year rule decides, and gets credit for it
    // (`assumed: 'year'`) rather than us silently keeping Jev's guess and losing that assumption.
    const yearChoice = stated(choiceOf(answers, 'outbound_year'))
    const year = yearChoice && candidates.dates.years.includes(Number(yearChoice)) ? Number(yearChoice) : null

    const parts = month && day
      ? { month, day: Number(day), year, relative }
      : { month: null, day: null, year: null, weekday, relative }

    const resolved = resolveDate(parts, today)
    if (!resolved) {
      return { kind: 'choices', questionId: 'outbound', question: QUESTION_TEXT.outbound, options: dateOptions(candidates, today) }
    }
    outbound = resolved.iso
    if (resolved.assumed === 'year') assumptions.push({ field: 'year', value: resolved.iso, reason: 'year' })
  }

  const arriveBy = noulOf(answers, 'arrive_by') > NOUL_GATE
  if (!outboundOverride && arriveBy && isLongHaul(origin, destination)) {
    const adjusted = addDays(outbound, -1)
    outbound = adjusted
    assumptions.push({ field: 'outbound', value: adjusted, reason: 'defaulted' })
  }

  const isOneWay = stated(choiceOf(answers, 'trip_type')) === 'one_way'
  let inbound: string | null = null
  if (!isOneWay) {
    const retMonth = stated(choiceOf(answers, 'return_month'))
    const retDay = stated(choiceOf(answers, 'return_day'))
    const retResolved = retMonth && retDay ? resolveDate({ month: retMonth, day: Number(retDay), year: null }, today) : null
    if (retResolved) {
      inbound = retResolved.iso
      if (retResolved.assumed === 'year') assumptions.push({ field: 'year', value: retResolved.iso, reason: 'year' })
    } else {
      inbound = addDays(outbound, 7)
      assumptions.push({ field: 'inbound', value: inbound, reason: 'defaulted' })
    }
  }

  const adultsRaw = stated(choiceOf(answers, 'party_adults'))
  const adults = adultsRaw ? Number(adultsRaw) : 1
  if (!adultsRaw) assumptions.push({ field: 'adults', value: '1', reason: 'unstated' })

  const cabinOf = (key: string): Cabin => {
    const v = stated(choiceOf(answers, key))
    if (v) return v as Cabin
    assumptions.push({ field: key, value: 'economy', reason: 'unstated' })
    return 'economy'
  }
  const cabinLong = cabinOf('cabin_long')
  const cabinShort = cabinOf('cabin_short')

  const maxStops = stated(choiceOf(answers, 'max_stops')) === 'nonstop_only' ? 0 : null
  const hotels = noulOf(answers, 'hotels_wanted') > NOUL_GATE

  return {
    kind: 'brief',
    brief: { origin, destination, sideTrip, outbound, inbound, adults, cabinLong, cabinShort, maxStops, hotels, arriveBy, assumptions },
  }
}

/**
 * Candidates -> questions -> one Jev call -> `assembleBrief`. Returns the request and response
 * alongside the outcome so the caller can record the call (`recordJevCall`, seat `intake`) —
 * this function spends money and must not hide the receipt.
 *
 * `overrides` (ledger ruling 2) replaces Jev's own answer for `origin`/`destination` with a
 * forced `{ choice, confidence: 1 }` before assembly — exactly what happens the moment she clicks
 * a choice card option and the router re-runs intake on her original message. `overrides.outbound`
 * is different: there is no single "outbound" Jev answer to overwrite (it's assembled from five
 * separate fields), so it is instead threaded straight through to `assembleBrief` as the ISO date
 * to use.
 */
export async function runIntake(
  deps: { jev: JevDeps },
  text: string,
  today: Date,
  lastOrigin: string | null,
  overrides: Partial<Record<'origin' | 'destination' | 'outbound', string>> = {},
): Promise<{ outcome: IntakeOutcome; request: JevRequest; response: JevResponse }> {
  const candidates: IntakeCandidates = { places: placeCandidates(text), dates: datePartCandidates(text), counts: countCandidates(text) }
  const questions = buildIntakeQuestions(text, candidates, today)
  const state = { message: text, today: today.toISOString().slice(0, 10), candidates }
  const request: JevRequest = { state, questions }
  const response = await askJev(deps.jev, request)

  const answers: Record<string, JevAnswer> = { ...response.answers }
  for (const key of ['origin', 'destination'] as const) {
    const value = overrides[key]
    if (value !== undefined) answers[key] = { type: 'choice', choice: value, confidence: 1, probabilities: { [value]: 1 } }
  }

  const outcome = assembleBrief(answers, candidates, today, lastOrigin, overrides.outbound)
  return { outcome, request, response }
}
