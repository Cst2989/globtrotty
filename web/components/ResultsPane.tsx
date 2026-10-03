'use client'

import { useState } from 'react'
import type { Assumption, Filter } from '@/src/results'
import type { ResultsView, ProposalRowLite, LinkLite } from '@/web/data'
import { applyFilterLite } from '@/web/filters'
import { FlightList } from './FlightList'
import { HotelList } from './HotelList'
import { FilterChips } from './FilterChips'
import { PinnedSummary } from './PinnedSummary'

export type ResultsPaneProps = {
  /** Every `results` row for this conversation, oldest first — `web/data.ts`'s `loadResults`. */
  results: ResultsView[]
  /** The proposal recording what's chosen so far (links already scoped to an accepted one), or `null` before anything is chosen. */
  proposal: (ProposalRowLite & { links: LinkLite[] }) | null
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  pending: boolean
  error: string | null
  onChoose: (kind: 'flight' | 'hotel', sourceId: string) => void
  onGetLinks: () => void
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return { y: y!, m: m!, d: d! }
}

/** One calendar day after an ISO `yyyy-mm-dd` date, computed in UTC so no local timezone enters it. */
function addOneDay(iso: string): string {
  const { y, m, d } = parseIsoDate(iso)
  const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000)
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  if (n % 10 === 1) return `${n}st`
  if (n % 10 === 2) return `${n}nd`
  if (n % 10 === 3) return `${n}rd`
  return `${n}th`
}

function humanDate(iso: string): string {
  const { m, d } = parseIsoDate(iso)
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/**
 * One assumption chip's text — spec's own examples: `{ field: 'year',
 * value: '2026-11-19', reason: 'year' }` → "Assumed: 2026";
 * `{ field: 'outbound', value: '2026-11-19', reason: 'defaulted' }` (the
 * "arrive by" day-earlier shift — `src/intake/brief.ts`'s `assembleBrief`)
 * → "Leaving 19 Nov to arrive by the 20th", where "the 20th" is one day
 * AFTER the stored (already-shifted) departure date — the day she told us
 * she must be there. Exported so it is pinned without rendering anything.
 */
export function assumptionChipText(a: Assumption): string {
  if (a.field === 'year') return `Assumed: ${a.value.slice(0, 4)}`
  if (a.field === 'outbound' && a.reason === 'defaulted') {
    return `Leaving ${humanDate(a.value)} to arrive by the ${ordinal(parseIsoDate(addOneDay(a.value)).d)}`
  }
  if (a.field === 'origin') return `Assumed origin: ${a.value}`
  if (a.field === 'inbound') return `Returning ${humanDate(a.value)}`
  if (a.field === 'adults') return 'Assumed: solo traveller'
  if (a.field === 'cabin_long' || a.field === 'cabin_short') return 'Assumed: economy'
  return `Assumed ${a.field}: ${a.value}`
}

function dedupeAssumptions(items: Assumption[]): Assumption[] {
  const seen = new Set<string>()
  const out: Assumption[] = []
  for (const a of items) {
    const key = `${a.field}:${a.value}:${a.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** The newest `ResultsView` of one kind, or `null` when there is none — `results` arrives oldest-first. */
function newestOfKind(results: ResultsView[], kind: 'flights' | 'hotels'): ResultsView | null {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.kind === kind) return results[i]!
  }
  return null
}

/**
 * Spec §5's results pane: assumption chips at the top, then the pinned
 * summary once anything is chosen, then the newest hotels list (if any),
 * then the newest flights list — in that order. Every piece here is pure
 * (callbacks as props); the filter chips' state is lifted to this component
 * (one `Filter` per kind, since the flight-only fields — nonstop, stops,
 * departure, airlines — mean nothing for a hotel list) and applied with
 * `applyFilterLite`. `test/web-results-render.test.ts` renders this directly
 * with `renderToStaticMarkup` — the local `useState` below is the same
 * pattern `ProposalCard` already uses, which that file's own tests confirm
 * is safe under static rendering (no router, no effects).
 */
export function ResultsPane({ results, proposal, now, pending, error, onChoose, onGetLinks }: ResultsPaneProps) {
  const [flightFilter, setFlightFilter] = useState<Filter>({})
  const [hotelFilter, setHotelFilter] = useState<Filter>({})

  const newestFlights = newestOfKind(results, 'flights')
  const newestHotels = newestOfKind(results, 'hotels')

  const assumptions = dedupeAssumptions(results.flatMap((r) => r.assumptions))

  const chosenFlightSourceId = proposal?.items.find((i) => i.kind === 'flight')?.sourceId ?? null
  const chosenHotelSourceId = proposal?.items.find((i) => i.kind === 'hotel')?.sourceId ?? null
  const hasChosen = proposal !== null && proposal.items.length > 0

  return (
    <div className="results-pane">
      {assumptions.length > 0 ? (
        <ul className="assumption-chips" aria-label="Assumptions">
          {assumptions.map((a) => (
            <li key={`${a.field}:${a.value}:${a.reason}`} className="assumption-chip">
              {assumptionChipText(a)}
            </li>
          ))}
        </ul>
      ) : null}

      {hasChosen ? (
        <PinnedSummary
          items={proposal!.items}
          totalMinor={proposal!.totalMinor}
          currency={proposal!.currency}
          decision={proposal!.decision}
          links={proposal!.links}
          pending={pending}
          error={error}
          onGetLinks={onGetLinks}
        />
      ) : null}

      {newestHotels ? (
        <section className="results-section" aria-label="Hotels">
          <FilterChips items={newestHotels.items} filter={hotelFilter} onChange={setHotelFilter} />
          <HotelList
            items={applyFilterLite(newestHotels.items, hotelFilter)}
            now={now}
            chosenSourceId={chosenHotelSourceId}
            onChoose={(sourceId) => onChoose('hotel', sourceId)}
          />
        </section>
      ) : null}

      {newestFlights ? (
        <section className="results-section" aria-label="Flights">
          <FilterChips items={newestFlights.items} filter={flightFilter} onChange={setFlightFilter} />
          <FlightList
            items={applyFilterLite(newestFlights.items, flightFilter)}
            now={now}
            chosenSourceId={chosenFlightSourceId}
            onChoose={(sourceId) => onChoose('flight', sourceId)}
          />
        </section>
      ) : null}
    </div>
  )
}
