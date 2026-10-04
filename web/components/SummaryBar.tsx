import { assumptionSentence } from '@/src/intake/assumptions'
import type { Assumption, ResultsContent } from '@/src/results'
import type { ResultsView } from '@/web/data'

export type SummaryBarProps = {
  kind: ResultsContent['kind']
  query: ResultsContent['query']
  assumptions: Assumption[]
  /** `web/data.ts`'s `cityNamesFor` — code to place-table city name, resolved server-side. */
  cityNames: Record<string, string>
  /**
   * This list's prices are past their ttl, so the bar offers to re-run the search. Absent (or
   * with no `onRefresh`) there is no link at all: nothing to offer, nothing to say.
   */
  stale?: boolean
  /** That re-run is in flight; the link says so and stops accepting presses. */
  refreshing?: boolean
  onRefresh?: () => void
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The calendar day an ISO `yyyy-mm-dd` names, read in UTC so the viewer's own timezone never
 * shifts it — the same rule the rest of this codebase applies to a naive date string.
 */
function utcDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d))
}

/** '19 Nov'. */
export function dayMonth(iso: string): string {
  const day = utcDay(iso)
  return `${day.getUTCDate()} ${MONTH_ABBR[day.getUTCMonth()]}`
}

/** 'Thu 19 Nov' — the weekday is computed, never taken from anything she typed. */
export function weekdayDayMonth(iso: string): string {
  return `${WEEKDAY_ABBR[utcDay(iso).getUTCDay()]} ${dayMonth(iso)}`
}

/** Whole nights between two ISO dates. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.max(0, Math.round((utcDay(checkOut).getTime() - utcDay(checkIn).getTime()) / 86_400_000))
}

/** 'premium_economy' -> 'Premium economy'. Enum in, fixed English out. */
function cabinLabel(cabin: string): string {
  const words = cabin.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The segments of the bar, in order, as plain strings — exported so
 * `test/web-results-render.test.ts` can pin the wording without walking markup.
 *
 * Flights: `Barcelona BCN → Tokyo TYO`, `Thu 19 Nov to Sun 6 Dec` (or `Thu 19 Nov, one way`),
 * `2 adults`, `Premium economy`. Hotels: `Tokyo`, `20 Nov to 6 Dec`, `16 nights`, `2 adults` —
 * no weekdays and no cabin, because neither means anything for a stay.
 */
export function summarySegments(
  kind: ResultsContent['kind'], query: ResultsContent['query'], cityNames: Record<string, string>,
): string[] {
  const label = (code: string): string => cityNames[code] ?? code

  if (kind === 'hotels') {
    const place = query.place ?? (query.to ? label(query.to) : null)
    const nights = query.inbound === null ? null : nightsBetween(query.outbound, query.inbound)
    return [
      ...(place ? [place] : []),
      query.inbound === null
        ? dayMonth(query.outbound)
        : `${dayMonth(query.outbound)} to ${dayMonth(query.inbound)}`,
      ...(nights === null ? [] : [`${nights} ${nights === 1 ? 'night' : 'nights'}`]),
      `${query.adults} ${query.adults === 1 ? 'adult' : 'adults'}`,
    ]
  }

  const route = query.from && query.to
    ? `${label(query.from)} ${query.from} → ${label(query.to)} ${query.to}`
    : (query.place ?? '')
  return [
    ...(route ? [route] : []),
    query.inbound === null
      ? `${weekdayDayMonth(query.outbound)}, one way`
      : `${weekdayDayMonth(query.outbound)} to ${weekdayDayMonth(query.inbound)}`,
    `${query.adults} ${query.adults === 1 ? 'adult' : 'adults'}`,
    ...(query.cabin ? [cabinLabel(query.cabin)] : []),
  ]
}

/**
 * The bar above a results list: what was searched for, as static pills, with everything the
 * office had to GUESS on one muted line underneath.
 *
 * This replaced the row of dashed "Assumed: …" chips (results UI pass 2, B). The chips said the
 * same thing twice over — one per assumption, each one a separate thing to read, and two of them
 * said "Assumed: 2026" because of bug A — while never saying what was actually searched for. The
 * trip itself is the thing she needs to check at a glance; the guesses are a footnote to it, and
 * they now read as one sentence (`assumptionSentence`, src/intake/assumptions.ts) that the
 * desk's own reply in the thread says word for word.
 *
 * Pure. `test/web-results-render.test.ts` renders it directly with `renderToStaticMarkup`.
 */
export function SummaryBar(
  { kind, query, assumptions, cityNames, stale = false, refreshing = false, onRefresh }: SummaryBarProps,
) {
  const segments = summarySegments(kind, query, cityNames)
  const assumed = assumptionSentence(assumptions, (code) => cityNames[code] ?? code)

  return (
    <div className="summary-bar">
      <ul className="summary-pills" aria-label={kind === 'hotels' ? 'Stay searched for' : 'Trip searched for'}>
        {segments.map((segment) => (
          <li key={segment} className="summary-pill">
            {segment}
          </li>
        ))}
      </ul>
      {/* A text link at the end of the line, not a banner across the top of the list.
          The banner was there to carry an apology; there is nothing to apologise for. The
          cards already say how old their prices are, Select re-quotes before it commits
          (`quoteForChoice`, src/agents/choose.ts), and this is simply the one thing she
          might want to do about it, where she is already reading what was searched for. */}
      {stale && onRefresh ? (
        <button type="button" className="summary-refresh" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? 'Refreshing prices…' : 'Refresh prices'}
        </button>
      ) : null}
      {assumed ? <p className="summary-assumed">{assumed}</p> : null}
    </div>
  )
}

/** The props `SummaryBar` needs out of one `ResultsView` — saves every caller spelling it out. */
export function summaryBarPropsFor(view: ResultsView): SummaryBarProps {
  return { kind: view.kind, query: view.query, assumptions: view.assumptions, cityNames: view.cityNames }
}
