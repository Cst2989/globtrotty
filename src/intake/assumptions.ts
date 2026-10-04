/**
 * One English phrase per `Assumption` (src/intake/brief.ts's `assembleBrief` is the only writer
 * of that list), and the one sentence they join into.
 *
 * Shared on purpose: the desk's own reply (`replyText`, src/agents/intake.ts) and the muted line
 * under the results pane's summary bar (`web/components/SummaryBar.tsx`) say the SAME thing about
 * the same guesses, and said it differently for a while — the chips said "Assumed: 2026" while
 * the reply said "I assumed: the year 2026".
 *
 * Deliberately free of the place table: a place code is turned into a city name by the `cityOf`
 * resolver the caller passes, because `src/intake/places.ts` reads `places.json` off disk at
 * import time and this module is imported by a client component. The agent passes its own
 * `placeLabel`; the pane passes a lookup over the names `web/data.ts` resolved server-side.
 */
import { addDays } from './dates.js'
import type { Assumption } from './brief.js'

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'D Mon' — '2026-11-26' -> '26 Nov'. ISO in, fixed English out; never her words. */
function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/** The day-of-month of an ISO date, as an ordinal — '2026-11-19' -> '19th'. */
function dayOrdinal(iso: string): string {
  return ordinal(Number(iso.slice(8, 10)))
}

/**
 * `null` for a field no reply mentions, so an `Assumption` this module has not been taught yet
 * is silently absent rather than printed as a raw field name.
 *
 * The 'outbound' phrase is the one `assembleBrief` writes exactly once, when an arrival deadline
 * moves the departure a day earlier: `a.value` is the ADJUSTED (departure) date, so the day she
 * arrives is one later. A `reason: 'year'` assumption carries the year itself since bug A
 * (results UI pass 2); `.slice(0, 4)` is kept so an older stored row carrying the full ISO date
 * still reads correctly.
 */
export function assumptionPhrase(a: Assumption, cityOf: (code: string) => string): string | null {
  switch (a.field) {
    case 'year': return `the year ${a.value.slice(0, 4)}`
    case 'outbound': return `leaving on the ${dayOrdinal(a.value)} to arrive by the ${dayOrdinal(addDays(a.value, 1))}`
    case 'origin': return `flying from ${cityOf(a.value)}`
    case 'inbound': return `coming back on ${dateLabel(a.value)}`
    case 'adults': return 'just the one of you'
    case 'cabin_long': return 'economy on the long legs'
    case 'cabin_short': return 'economy on the short legs'
    default: return null
  }
}

/**
 * 'Assumed: the year 2026, and leaving on the 19th to arrive by the 20th.' — one sentence, or the
 * empty string when nothing was assumed (the caller prints nothing at all in that case rather
 * than an empty "Assumed:").
 *
 * Phrases are deduplicated by their own TEXT as well, on top of `assembleBrief`'s own
 * (field, reason, value) dedupe: two different fields can legitimately produce the same words
 * once a resolver is applied, and saying it twice reads like a bug either way.
 */
export function assumptionSentence(items: Assumption[], cityOf: (code: string) => string): string {
  const phrases = [...new Set(
    items.map((a) => assumptionPhrase(a, cityOf)).filter((s): s is string => s !== null),
  )]
  if (phrases.length === 0) return ''
  if (phrases.length === 1) return `Assumed: ${phrases[0]}.`
  const head = phrases.slice(0, -1).join(', ')
  return `Assumed: ${head}, and ${phrases[phrases.length - 1]}.`
}
