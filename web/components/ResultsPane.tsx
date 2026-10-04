'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Filter } from '@/src/results'
import type { ResultsView, ProposalRowLite, LinkLite } from '@/web/data'
import { applyFilterLite } from '@/web/filters'
import { FlightList } from './FlightList'
import { HotelList } from './HotelList'
import { FilterChips } from './FilterChips'
import { PinnedSummary } from './PinnedSummary'
import { SummaryBar, summaryBarPropsFor } from './SummaryBar'
import { errorForStatus } from './ProposalCard'

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

/** The newest `ResultsView` of one kind, or `null` when there is none — `results` arrives oldest-first. */
function newestOfKind(results: ResultsView[], kind: 'flights' | 'hotels'): ResultsView | null {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.kind === kind) return results[i]!
  }
  return null
}

/**
 * The chip state for one kind, tagged with the `results` row it was derived from — see the
 * reset in `ResultsPane` for why the tag is needed.
 */
type KindFilter = { messageId: string | null; filter: Filter }

function chipsFor(view: ResultsView | null): KindFilter {
  return { messageId: view?.messageId ?? null, filter: view?.filter ?? {} }
}

/**
 * Spec §5's results pane: the pinned summary once anything is chosen, then
 * the newest hotels list (if any), then the newest flights list — each list
 * under its own `SummaryBar` (what was searched for, plus the assumption
 * line that replaced the old row of "Assumed: …" chips). Every piece here is pure
 * (callbacks as props); the filter chips' state is lifted to this component
 * (one `Filter` per kind, since the flight-only fields — nonstop, stops,
 * departure, airlines — mean nothing for a hotel list) and applied with
 * `applyFilterLite`. `test/web-results-render.test.ts` renders this directly
 * with `renderToStaticMarkup` — the local `useState` below is the same
 * pattern `ProposalCard` already uses, which that file's own tests confirm
 * is safe under static rendering (no router, no effects).
 */
export function ResultsPane({ results, proposal, now, pending, error, onChoose, onGetLinks }: ResultsPaneProps) {
  const newestFlights = newestOfKind(results, 'flights')
  const newestHotels = newestOfKind(results, 'hotels')

  // M4: the chips used to start empty whatever the row said, so after a TYPED filter the chips
  // rendered unselected while the list below them was narrowed — two different stories about
  // the same list. `ResultsView.filter` is the row's own filter, so the chips start from it.
  //
  // Tracked against the row's `messageId` and reset during render (React's documented
  // adjust-state-when-props-change pattern) rather than with `useState`'s initializer alone: a
  // typed filter arrives through `router.refresh()`, which re-renders this instance instead of
  // remounting it, so an initializer-only version would keep showing the PREVIOUS row's chips.
  // Her own chip clicks are kept while the row is unchanged, which is the whole point of the
  // state. No effect is involved, so `renderToStaticMarkup` is unaffected.
  const [flightChips, setFlightChips] = useState<KindFilter>(() => chipsFor(newestFlights))
  const [hotelChips, setHotelChips] = useState<KindFilter>(() => chipsFor(newestHotels))
  if (flightChips.messageId !== (newestFlights?.messageId ?? null)) setFlightChips(chipsFor(newestFlights))
  if (hotelChips.messageId !== (newestHotels?.messageId ?? null)) setHotelChips(chipsFor(newestHotels))
  const flightFilter = flightChips.filter
  const hotelFilter = hotelChips.filter
  const setFlightFilter = (filter: Filter) =>
    setFlightChips({ messageId: newestFlights?.messageId ?? null, filter })
  const setHotelFilter = (filter: Filter) =>
    setHotelChips({ messageId: newestHotels?.messageId ?? null, filter })

  const chosenFlightSourceId = proposal?.items.find((i) => i.kind === 'flight')?.sourceId ?? null
  const chosenHotelSourceId = proposal?.items.find((i) => i.kind === 'hotel')?.sourceId ?? null
  const hasChosen = proposal !== null && proposal.items.length > 0

  return (
    <div className="results-pane">
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
          <SummaryBar {...summaryBarPropsFor(newestHotels)} />
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
          <SummaryBar {...summaryBarPropsFor(newestFlights)} />
          <FilterChips items={newestFlights.items} filter={flightFilter} onChange={setFlightFilter} />
          <FlightList
            items={applyFilterLite(newestFlights.items, flightFilter)}
            adults={newestFlights.query.adults}
            now={now}
            chosenSourceId={chosenFlightSourceId}
            onChoose={(sourceId) => onChoose('flight', sourceId)}
          />
        </section>
      ) : null}
    </div>
  )
}

export type ResultsPaneLiveProps = {
  conversationId: string
  results: ResultsView[]
  proposal: (ProposalRowLite & { links: LinkLite[] }) | null
}

const GENERIC_ERROR = 'That could not be sent. Please try again.'

/**
 * Task 10: the client island for the results pane. `onChoose` POSTs
 * `{ kind, sourceId }` to `/api/conversations/[id]/choose` (Task 7's route —
 * `web/chooseRoute.ts`, a different task, in flight alongside this one; a
 * 404 there falls through `errorForStatus`'s own default branch to the same
 * generic copy as any other unhandled status, never a route-specific
 * message). `onGetLinks` reuses the existing `/api/proposals/[id]/decide`
 * endpoint with `{ decision: 'accept' }`, the same request
 * `ProposalCardLive`'s Accept button makes, and only fires it while
 * `proposal.decision` is still `null` — the button itself
 * (`PinnedSummary`) already only renders in that state, this is just the
 * same guard kept here too rather than trusted blindly. `router.refresh()`
 * on success lets the RLS-scoped server read (`loadResults`/`loadProposals`)
 * pick up the change, same pattern as every other `*Live` wrapper in this
 * codebase.
 */
export function ResultsPaneLive({ conversationId, results, proposal }: ResultsPaneLiveProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(path: string, body: unknown) {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(errorForStatus(res.status))
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
    } finally {
      setPending(false)
    }
  }

  return (
    <ResultsPane
      results={results}
      proposal={proposal}
      pending={pending}
      error={error}
      onChoose={(kind, sourceId) => void post(`/api/conversations/${conversationId}/choose`, { kind, sourceId })}
      onGetLinks={() => {
        if (!proposal || proposal.decision !== null) return
        void post(`/api/proposals/${proposal.id}/decide`, { decision: 'accept' })
      }}
    />
  )
}
