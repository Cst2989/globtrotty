'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Filter } from '@/src/results'
import type { ResultsView, ProposalRowLite, LinkLite, SkeletonMode } from '@/web/data'
import { applyFilterLite, sortItemsLite, type Sort } from '@/web/filters'
import { FlightList } from './FlightList'
import { HotelList } from './HotelList'
import { FilterRail } from './FilterRail'
import { SortTabs } from './SortTabs'
import { PinnedSummary } from './PinnedSummary'
import { SummaryBar, summaryBarPropsFor } from './SummaryBar'
import { ResultsSkeleton } from './ResultsSkeleton'
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
  /**
   * `web/data.ts`'s `skeletonMode` (E): `'full'` replaces the whole pane with a placeholder
   * while the first search runs, `'hotels'` puts a hotel placeholder above the flights she
   * already has while `handleChooseFlight` searches stays, `null` shows just the results.
   */
  skeleton?: SkeletonMode
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
 * The rail and tab state for one kind, tagged with the `results` row it was derived from — see
 * the reset in `ResultsPane` for why the tag is needed.
 */
type KindState = { messageId: string | null; filter: Filter; sort: Sort }

function stateFor(view: ResultsView | null): KindState {
  return { messageId: view?.messageId ?? null, filter: view?.filter ?? {}, sort: 'best' }
}

const FLIGHT_SORTS: Sort[] = ['best', 'cheapest', 'fastest']
/** No "fastest" for a stay: nothing about a hotel row has a duration to be fast. */
const HOTEL_SORTS: Sort[] = ['best', 'cheapest']

/**
 * Spec §5's results pane: the pinned summary once anything is chosen, then the newest hotels
 * list (if any), then the newest flights list.
 *
 * Each list is one section: a `SummaryBar` (what was searched for, and what had to be guessed),
 * then a `FilterRail` beside it and `SortTabs` above it (results UI pass 2, D). Every piece here
 * is pure (callbacks as props); the rail's filter and the tabs' sort are lifted to this
 * component, one pair per kind — the flight-only fields (stops, bags, departure, airlines) mean
 * nothing for a stay, and a stay's rating means nothing for a flight — and applied with
 * `applyFilterLite` then `sortItemsLite`, in that order, so the tab summaries describe the
 * filtered list rather than the whole corpus.
 *
 * `test/web-results-render.test.ts` renders this directly with `renderToStaticMarkup` — the
 * local `useState` below is the same pattern `ProposalCard` already uses, which that file's own
 * tests confirm is safe under static rendering (no router, no effects).
 */
export function ResultsPane(
  { results, proposal, now, pending, error, skeleton = null, onChoose, onGetLinks }: ResultsPaneProps,
) {
  const newestFlights = newestOfKind(results, 'flights')
  const newestHotels = newestOfKind(results, 'hotels')

  // M4: the rail used to start empty whatever the row said, so after a TYPED filter it rendered
  // unselected while the list beside it was narrowed — two different stories about the same
  // list. `ResultsView.filter` is the row's own filter, so the rail starts from it.
  //
  // Tracked against the row's `messageId` and reset during render (React's documented
  // adjust-state-when-props-change pattern) rather than with `useState`'s initializer alone: a
  // typed filter arrives through `router.refresh()`, which re-renders this instance instead of
  // remounting it, so an initializer-only version would keep showing the PREVIOUS row's state.
  // Her own clicks are kept while the row is unchanged, which is the whole point of the state —
  // and the sort tab resets with it, because "Cheapest" over last search's corpus is not an
  // answer about this one. No effect is involved, so `renderToStaticMarkup` is unaffected.
  const [flightState, setFlightState] = useState<KindState>(() => stateFor(newestFlights))
  const [hotelState, setHotelState] = useState<KindState>(() => stateFor(newestHotels))
  if (flightState.messageId !== (newestFlights?.messageId ?? null)) setFlightState(stateFor(newestFlights))
  if (hotelState.messageId !== (newestHotels?.messageId ?? null)) setHotelState(stateFor(newestHotels))
  const setFlightFilter = (filter: Filter) => setFlightState({ ...flightState, filter })
  const setHotelFilter = (filter: Filter) => setHotelState({ ...hotelState, filter })
  const setFlightSort = (sort: Sort) => setFlightState({ ...flightState, sort })
  const setHotelSort = (sort: Sort) => setHotelState({ ...hotelState, sort })

  const flightItems = newestFlights
    ? sortItemsLite(applyFilterLite(newestFlights.items, flightState.filter), flightState.sort)
    : []
  const hotelItems = newestHotels
    ? sortItemsLite(applyFilterLite(newestHotels.items, hotelState.filter), hotelState.sort)
    : []

  const chosenFlightSourceId = proposal?.items.find((i) => i.kind === 'flight')?.sourceId ?? null
  const chosenHotelSourceId = proposal?.items.find((i) => i.kind === 'hotel')?.sourceId ?? null
  const hasChosen = proposal !== null && proposal.items.length > 0

  // Nothing to show beside a placeholder, and nothing to put it above: the whole pane IS the
  // skeleton. Returning early rather than rendering empty sections keeps the "searching" state
  // from being a half-drawn version of the real one.
  if (skeleton === 'full') {
    return (
      <div className="results-pane">
        <ResultsSkeleton kind="flights" />
      </div>
    )
  }

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

      {skeleton === 'hotels' ? <ResultsSkeleton kind="hotels" /> : null}

      {newestHotels ? (
        <section className="results-section" aria-label="Hotels">
          <SummaryBar {...summaryBarPropsFor(newestHotels)} />
          <div className="results-layout">
            <FilterRail
              kind="hotels" items={newestHotels.items}
              filter={hotelState.filter} onChange={setHotelFilter}
            />
            <div className="results-main">
              <SortTabs
                items={hotelItems} sorts={HOTEL_SORTS}
                active={hotelState.sort} onChange={setHotelSort}
              />
              <HotelList
                items={hotelItems}
                now={now}
                chosenSourceId={chosenHotelSourceId}
                onChoose={(sourceId) => onChoose('hotel', sourceId)}
              />
            </div>
          </div>
        </section>
      ) : null}

      {newestFlights ? (
        <section className="results-section" aria-label="Flights">
          <SummaryBar {...summaryBarPropsFor(newestFlights)} />
          <div className="results-layout">
            <FilterRail
              kind="flights" items={newestFlights.items}
              filter={flightState.filter} onChange={setFlightFilter}
            />
            <div className="results-main">
              <SortTabs
                items={flightItems} sorts={FLIGHT_SORTS}
                active={flightState.sort} onChange={setFlightSort}
              />
              <FlightList
                items={flightItems}
                adults={newestFlights.query.adults}
                now={now}
                chosenSourceId={chosenFlightSourceId}
                onChoose={(sourceId) => onChoose('flight', sourceId)}
              />
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

export type ResultsPaneLiveProps = {
  conversationId: string
  results: ResultsView[]
  proposal: (ProposalRowLite & { links: LinkLite[] }) | null
  skeleton?: SkeletonMode
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
export function ResultsPaneLive({ conversationId, results, proposal, skeleton = null }: ResultsPaneLiveProps) {
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
      skeleton={skeleton}
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
