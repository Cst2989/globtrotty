/**
 * The Jev "brief": one fan-out call that turns her message plus the candidates
 * `src/intake/candidates.ts` found into either a complete `TripBrief` or a clickable choice
 * card. Jev never does calendar arithmetic or looks anything up by name — it only picks among
 * the candidates and fixed vocabularies code hands it; `src/intake/dates.ts` does the math and
 * `src/intake/places.ts`'s table supplies every label a choice card shows her.
 */
import { askJev, choiceQ, noulQ, type JevAnswer, type JevDeps, type JevQuestion, type JevRequest, type JevResponse } from '../jev/client.js'
import { placeCandidates, datePartCandidates, countCandidates, type PlaceCandidate, type DateParts } from './candidates.js'
import { CODE_MAP, isLongHaul, type Region } from './places.js'
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

/**
 * Spec section 3: a choice card asks ONE question with 2 to 4 clickable options. Both ends are
 * load-bearing, and the final review's C2 is what happens without the lower one: `placeOptions`
 * and `dateOptions` could legitimately return `[]` (a message naming no place the table knows,
 * with no stored last origin — "I want to go somewhere warm next month, just me"),
 * `ChoicesContentSchema` accepted `.min(1)`, and `buildAttachmentRows` `.parse`s, so the park
 * step THREW after the Jev call had already been paid for and her very first turn failed
 * outright. One option is nearly as bad: there is nothing to choose, and clicking the only
 * answer on offer re-runs intake on a value she never picked. So both builders below guarantee
 * the range by construction, and `ChoicesContentSchema` now enforces `.min(2).max(4)` as the
 * backstop rather than the contract.
 */
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4

/**
 * The last resort for a place card: the four busiest passenger metros of a region, by code.
 * Reached only when Jev ranked nothing, she named nothing the place table recognises, and we
 * have no stored origin for her — at which point the honest thing is to ask a question she can
 * answer rather than fail the turn, and "the four biggest airports near where this trip is
 * going" is the least-wrong guess available without a model call.
 *
 * Every code here is checked against `CODE_MAP` by `placeOptions` before it becomes an option,
 * so a places.json edit that drops one degrades to a shorter list rather than an option with a
 * raw code for a label.
 */
const BUSIEST_BY_REGION: Record<Region, readonly string[]> = {
  europe:        ['LON', 'PAR', 'BCN', 'BER'],
  north_america: ['NYC', 'LAX', 'CHI', 'YYZ'],
  asia:          ['TYO', 'SEL', 'BKK', 'SIN'],
  oceania:       ['SYD', 'MEL', 'AKL', 'BNE'],
  africa:        ['CAI', 'JNB', 'CMN', 'NBO'],
  south_america: ['SAO', 'BOG', 'BUE', 'LIM'],
  middle_east:   ['DXB', 'DOH', 'RUH', 'TLV'],
}

/**
 * Which region's busiest metros to offer. The anchor is the place we DO know on this card — the
 * destination on an origin card, the origin on a destination card — because a flight has two
 * ends and the one we are missing is nearly always near the one we have. With neither end known
 * there is nothing in the message to go on, so Europe's four are the documented default
 * (`['LON', 'PAR', 'BCN', 'BER']`): this product's traffic is European, and a wrong guess here
 * costs her one extra click on a card that would otherwise have been empty.
 */
function busiestFor(anchor: string | null): readonly string[] {
  const region = anchor === null ? undefined : CODE_MAP.get(anchor)?.region
  return region === undefined ? BUSIEST_BY_REGION.europe : BUSIEST_BY_REGION[region]
}

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

/**
 * The options for a place card: 2 to 4 metro codes, labelled from the place table — never her
 * span, never the model's words.
 *
 * `exclude` is the OTHER end of the flight when we already know it, and dropping it is the
 * review's I4: "Flights to Tokyo in November" ranks the same candidate list for every place
 * question, so the origin card used to offer "Tokyo" as the answer to "Which city are you
 * flying from?", and clicking it produced a TYO -> TYO search.
 *
 * The four sources are tried in order of how much they reflect what she actually said, and each
 * later one only fires while the list is still short of `MIN_OPTIONS`:
 *   1. Jev's own ranking over the code-found candidates (what she wrote, best first);
 *   2. her last origin, if we have one — a real fact about her, just not one in this message;
 *   3. the code-found candidate list itself, for a candidate Jev gave no probability at all;
 *   4. `busiestFor`'s fixed four, which involves no evidence and is the last resort.
 */
function placeOptions(
  probabilities: Record<string, number>,
  candidates: IntakeCandidates,
  exclude: string | null,
  lastOrigin: string | null,
): { id: string; label: string }[] {
  const picked: string[] = []
  const add = (code: string): void => {
    if (picked.length >= MAX_OPTIONS) return
    if (code === 'none' || code === 'unstated') return
    if (exclude !== null && code === exclude) return
    if (!CODE_MAP.has(code)) return          // a label we cannot write is not an option
    if (picked.includes(code)) return
    picked.push(code)
  }

  for (const [code] of Object.entries(probabilities).sort((a, b) => b[1] - a[1])) add(code)
  if (picked.length < MIN_OPTIONS && lastOrigin !== null) add(lastOrigin)
  if (picked.length < MIN_OPTIONS) for (const p of candidates.places) add(p.code)
  if (picked.length < MIN_OPTIONS) for (const code of busiestFor(exclude)) add(code)

  return picked.map((code) => ({ id: code, label: CODE_MAP.get(code)!.city }))
}

/**
 * The options for the outbound-date card: the candidate day/month combinations she actually
 * wrote, as ISO labels, 2 to 4 of them.
 *
 * The top-up exists for the same reason `placeOptions`'s does (C2): a message with no date in it
 * at all, or one whose only date does not resolve, left this empty and failed the turn. A
 * fortnight out and then weekly is the fallback — far enough ahead that the fares are bookable,
 * spread widely enough that the four options are meaningfully different, and anchored on
 * `today` so the card never offers a date in the past.
 */
function dateOptions(c: IntakeCandidates, today: Date): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  const push = (iso: string): void => {
    if (out.length >= MAX_OPTIONS) return
    if (out.some((o) => o.id === iso)) return
    out.push({ id: iso, label: iso })
  }
  for (const month of c.dates.months) {
    for (const day of c.dates.days) {
      const resolved = resolveDate({ month, day, year: null }, today)
      if (resolved) push(resolved.iso)
      if (out.length >= MAX_OPTIONS) return out
    }
  }
  const todayIso = today.toISOString().slice(0, 10)
  for (let weeks = 2; out.length < MIN_OPTIONS && weeks <= 5; weeks++) push(addDays(todayIso, weeks * 7))
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
  /**
   * Bug A (results UI pass 2): `assumptions` is a list of DISTINCT things we guessed, not a log
   * of every place a guess was used. The year is the case that proved it — a round trip resolves
   * two bare dates ("20th of nov", "sunday 6th of december"), each one credits
   * `resolveDate`'s nearest-future-year rule, and the pane rendered "Assumed: 2026" twice.
   * Deduped by the triple (field, reason, value), FIRST entry wins.
   *
   * That triple only collapses the two year entries because a `reason: 'year'` assumption now
   * carries the YEAR as its `value` ('2026'), not the whole resolved ISO date: the ISO dates
   * differ (2026-11-19 vs 2026-12-06) while the assumption they evidence is the same one.
   * Every reader already only wanted the year — `assumptionChipText`
   * (web/components/SummaryBar.tsx) and `assumptionPhrase` (src/intake/assumptions.ts) both
   * `.slice(0, 4)` it — so nothing downstream loses information.
   */
  const pushAssumption = (a: Assumption): void => {
    if (assumptions.some((x) => x.field === a.field && x.reason === a.reason && x.value === a.value)) return
    assumptions.push(a)
  }

  // The destination is read FIRST even though the origin card is offered first, because the
  // origin card has to be able to exclude it (I4) — and because `origin === destination` is
  // never a trip, however confident Jev was about either end.
  const destAnswer = choiceOf(answers, 'destination')
  const destination = stated(destAnswer)

  const originAnswer = choiceOf(answers, 'origin')
  let origin = stated(originAnswer)
  // I4: refuse origin === destination rather than searching TYO -> TYO and telling her "I could
  // not find flights for 1 adult, Tokyo to Tokyo". Dropping the origin falls through to the
  // origin card below, whose options exclude the destination, so the click that caused this
  // (an override at confidence 1) cannot be offered again and the loop cannot repeat.
  if (origin !== null && origin === destination) origin = null
  if (!origin) {
    // The same equality rule applies to the stored default: a last origin that happens to be
    // where she is going is not a usable origin either.
    if (lastOrigin && lastOrigin !== destination) {
      origin = lastOrigin
      pushAssumption({ field: 'origin', value: lastOrigin, reason: 'defaulted' })
    } else {
      return {
        kind: 'choices', questionId: 'origin', question: QUESTION_TEXT.origin,
        options: placeOptions(originAnswer?.probabilities ?? {}, candidates, destination, lastOrigin),
      }
    }
  }

  if (!destination) {
    return {
      kind: 'choices', questionId: 'destination', question: QUESTION_TEXT.destination,
      options: placeOptions(destAnswer?.probabilities ?? {}, candidates, origin, lastOrigin),
    }
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
    if (resolved.assumed === 'year') pushAssumption({ field: 'year', value: resolved.iso.slice(0, 4), reason: 'year' })
  }

  const arriveBy = noulOf(answers, 'arrive_by') > NOUL_GATE
  if (!outboundOverride && arriveBy && isLongHaul(origin, destination)) {
    const adjusted = addDays(outbound, -1)
    outbound = adjusted
    pushAssumption({ field: 'outbound', value: adjusted, reason: 'defaulted' })
  }

  const isOneWay = stated(choiceOf(answers, 'trip_type')) === 'one_way'
  let inbound: string | null = null
  if (!isOneWay) {
    const retMonth = stated(choiceOf(answers, 'return_month'))
    const retDay = stated(choiceOf(answers, 'return_day'))
    const retResolved = retMonth && retDay ? resolveDate({ month: retMonth, day: Number(retDay), year: null }, today) : null
    if (retResolved) {
      inbound = retResolved.iso
      if (retResolved.assumed === 'year') pushAssumption({ field: 'year', value: retResolved.iso.slice(0, 4), reason: 'year' })
    } else {
      inbound = addDays(outbound, 7)
      pushAssumption({ field: 'inbound', value: inbound, reason: 'defaulted' })
    }
  }

  const adultsRaw = stated(choiceOf(answers, 'party_adults'))
  const adults = adultsRaw ? Number(adultsRaw) : 1
  if (!adultsRaw) pushAssumption({ field: 'adults', value: '1', reason: 'unstated' })

  const cabinOf = (key: string): Cabin => {
    const v = stated(choiceOf(answers, key))
    if (v) return v as Cabin
    pushAssumption({ field: key, value: 'economy', reason: 'unstated' })
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
