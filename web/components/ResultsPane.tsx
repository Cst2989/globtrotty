'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CaretDown } from '@phosphor-icons/react'
import { formatMoney, money } from '@/src/money'
import type { Filter } from '@/src/results'
import type { ResultsView, ResultItemLite, ProposalRowLite, LinkLite, SkeletonMode } from '@/web/data'
import { applyFilterLite, sortItemsLite, type Sort } from '@/web/filters'
import { FlightList } from './FlightList'
import { HotelList } from './HotelList'
import { FilterBar } from './FilterBar'
import { SortTabs } from './SortTabs'
import { PinnedSummary } from './PinnedSummary'
import { SummaryBar, summaryBarPropsFor } from './SummaryBar'
import { ResultsSkeleton } from './ResultsSkeleton'
import { errorForStatus } from './ProposalCard'
import { useActivity } from './activity'

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
  /**
   * Pass 3, section 6a: the card she just pressed Select on, set by `ResultsPaneLive`
   * SYNCHRONOUSLY — before its POST — and cleared only if that POST comes back unusable.
   *
   * Pressing Select used to change nothing for about three seconds: the action row, the turn,
   * the proposal path and the hotel search all had to land before `router.refresh()` brought
   * back a page that finally said "Selected". Everything that answer eventually shows is
   * already known here the moment she clicks: WHICH card she picked, that the others are no
   * longer offers, and what the office does next. So this renders all three at once — the
   * ribbon, the disabled Selects, the pinned block, and the placeholder for the search that is
   * starting — and the server's own version of the same state replaces it without moving
   * anything.
   */
  pendingChoice?: PendingChoice | null
  /**
   * Pass 3 (author's correction to section 1): the kinds whose search is being re-run right now.
   * Every card in those lists shows a shimmering block where its price was, and nothing else
   * about it moves.
   */
  updatingKinds?: ('flights' | 'hotels')[]
}

export type PendingChoice = { kind: 'flight' | 'hotel'; sourceId: string }

/**
 * Whether an optimistic state survives the response that eventually arrives.
 *
 * `200` is the only `keep`: `submitAction` (src/handler.ts) writes the action row and the turn
 * in ONE transaction and returns `busy` (409) or `limit_reached` (429) having written NEITHER —
 * unlike `submitMessage`, which preserves her typed words on both. So for a card press there is
 * no status where the optimistic screen is still true but the row is missing: anything other
 * than 200 means nothing happened, and the screen has to go back to what it was.
 *
 * Pure, so `test/web-results-render.test.ts` pins every status without a fetch mock.
 */
export function outcomeForStatus(status: number): 'keep' | 'rollback' {
  return status === 200 ? 'keep' : 'rollback'
}

/**
 * Whether this row's prices should be re-run WITHOUT being asked (pass 3, the author's
 * correction to section 1).
 *
 * The first version of this put a banner and a "Refresh prices" button above a stale list. The
 * author's objection is the right one: she never wanted stale prices, she wanted current ones,
 * and a button asking her to confirm that is the office making its own bookkeeping her problem.
 * Nothing about the decision needs her — the row says it is past its ttl, the stored search says
 * exactly what to re-run, and the whole thing costs one supplier call. So the pane just does it,
 * and says so where she is already looking: a shimmer where each price was, and "Updating
 * prices" on the status line.
 *
 * `status !== 'working'` is the one guard that matters: a turn already in flight would refuse
 * this one with a 409 (`submitAction`'s one-active-turn index), and firing it anyway would
 * replace real prices with a skeleton that is never going to fill. Everything else — once per
 * row, never twice for the same one — is the caller's `useRef`.
 *
 * Pure, so `test/web-results-render.test.ts` pins every branch.
 */
export function shouldAutoRefresh(view: { stale: boolean }, status: string): boolean {
  return view.stale && status !== 'working'
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
/**
 * No "fastest" for a stay: nothing about a hotel row has a duration to be fast. "Top rated" takes
 * its place (hotels pass, section 4), which is the figure a stay is actually compared on.
 */
const HOTEL_SORTS: Sort[] = ['best', 'cheapest', 'rated']

/**
 * Hotels pass, section 7. Splits a filtered, sorted list into the items that match what she asked
 * for and the ones Jev found something wrong with.
 *
 * An item with NO entry in `verdicts` counts as matched, deliberately: it was never checked (it
 * sat past the twenty options Jev scores, or the row predates the field), and hiding an unchecked
 * option behind a collapsed section would be the office claiming a finding it does not have.
 * `verdicts === undefined` — the whole list unchecked — short-circuits to the same thing.
 *
 * Pure, so `test/web-results-render.test.ts` pins every branch.
 */
export function splitByVerdict(
  items: ResultItemLite[], verdicts: ResultsView['verdicts'],
): { matched: ResultItemLite[]; unmatched: ResultItemLite[] } {
  if (!verdicts) return { matched: items, unmatched: [] }
  const matched: ResultItemLite[] = []
  const unmatched: ResultItemLite[] = []
  for (const item of items) {
    const issues = verdicts[item.sourceId]?.issues ?? []
    if (issues.length > 0) unmatched.push(item)
    else matched.push(item)
  }
  return { matched, unmatched }
}

/** `sourceId` -> its matched facts, for the cards' green chips. Empty when nothing was checked. */
export function matchesBySourceId(verdicts: ResultsView['verdicts']): Record<string, string[]> {
  if (!verdicts) return {}
  return Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, v.matches]))
}

/** "3 flights didn't match what you asked" / "1 hotel didn't match what you asked". */
export function unmatchedLabel(count: number, kind: 'flights' | 'hotels'): string {
  const noun = kind === 'flights'
    ? (count === 1 ? 'flight' : 'flights')
    : (count === 1 ? 'hotel' : 'hotels')
  return `${count} ${noun} didn't match what you asked`
}

/**
 * The collapsed section under a list: what Jev found wrong, and with what.
 *
 * Collapsed rather than dropped, because "wrong for what she asked" is a judgment and she is the
 * one entitled to overrule it — a self-transfer she is happy to risk, a rental she would take for
 * the price. Each card inside carries the reasons, so expanding it answers "why" without a second
 * click.
 */
function UnmatchedSection(
  { kind, items, verdicts, children }: {
    kind: 'flights' | 'hotels'
    items: ResultItemLite[]
    verdicts: NonNullable<ResultsView['verdicts']>
    children: ReactNode
  },
) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <div className="unmatched">
      <button
        type="button"
        className="unmatched-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretDown size={14} aria-hidden="true" data-open={open ? 'true' : 'false'} />
        {unmatchedLabel(items.length, kind)}
      </button>
      {open ? (
        <div className="unmatched-panel" id={panelId}>
          <ul className="unmatched-reasons">
            {items.map((item) => (
              <li key={item.sourceId} className="unmatched-reason">
                <span className="unmatched-reason-name">{item.name}</span>
                {(verdicts[item.sourceId]?.issues ?? []).map((issue) => (
                  <span key={issue} className="issue-chip">{issue}</span>
                ))}
              </li>
            ))}
          </ul>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** The muted line over a list nothing checked — section 7's answer to a failed Jev call. */
function UncheckedNote() {
  return <p className="results-unchecked">Not checked against your request</p>
}

/**
 * The pinned block for a choice the server has not confirmed yet (pass 3, section 6a): the one
 * card she picked, with its price, under the same heading the real `PinnedSummary` uses.
 *
 * No total and no "Get booking links": a total needs the gates' own arithmetic and the button
 * needs a proposal id, neither of which exists yet. Promising either would be the optimistic
 * screen claiming something the server has not said.
 */
function PendingPinned(
  { item, kind }: { item: ResultItemLite; kind: 'flight' | 'hotel' },
) {
  return (
    <section className="pinned-summary" aria-label="Your trip so far">
      <p className="pinned-pending-label">{kind === 'flight' ? 'Chosen flight' : 'Chosen hotel'}</p>
      <ul className="pinned-items">
        <li className="pinned-item">
          <span className="pinned-item-name">{item.name}</span>
          <span className="pinned-item-price">
            {formatMoney(money(BigInt(item.priceMinor), item.currency))}
          </span>
        </li>
      </ul>
    </section>
  )
}

/**
 * What a chosen HOTEL promises: not another list, but the summary of the whole trip, which
 * `handleChooseHotel` is off building through the gates and the reviewer. A skeleton list would
 * be a lie about what is coming.
 */
function PendingTripSummary() {
  return (
    <section className="results-section results-skeleton" aria-label="Putting the trip together">
      <div className="summary-bar" aria-hidden="true">
        <div className="summary-pills">
          <span className="skeleton-pill skeleton-pill-wide" />
          <span className="skeleton-pill" />
        </div>
      </div>
      <p className="results-skeleton-note" role="status">Putting the trip together…</p>
    </section>
  )
}

/** The item one `sourceId` names in a row, or `null` — what the pending pinned block renders. */
function itemById(view: ResultsView | null, sourceId: string): ResultItemLite | null {
  return view?.items.find((i) => i.sourceId === sourceId) ?? null
}

/**
 * Spec §5's results pane: the pinned summary once anything is chosen, then the newest hotels
 * list (if any), then the newest flights list.
 *
 * Each list is one section, stacked: a `SummaryBar` (what was searched for, and what had to be
 * guessed), the stale banner when its prices have aged out, the horizontal `FilterBar` (pass 3,
 * section 3 — it replaced the left rail results UI pass 2 put beside the list), the `SortTabs`,
 * and the list. Every piece here is pure (callbacks as props); the bar's filter and the tabs'
 * sort are lifted to this component, one pair per kind — the flight-only fields (stops, bags, departure, airlines) mean
 * nothing for a stay, and a stay's rating means nothing for a flight — and applied with
 * `applyFilterLite` then `sortItemsLite`, in that order, so the tab summaries describe the
 * filtered list rather than the whole corpus.
 *
 * `test/web-results-render.test.ts` renders this directly with `renderToStaticMarkup` — the
 * local `useState` below is the same pattern `ProposalCard` already uses, which that file's own
 * tests confirm is safe under static rendering (no router, no effects).
 */
export function ResultsPane(
  {
    results, proposal, now, pending, error, skeleton = null, pendingChoice = null, updatingKinds = [],
    onChoose, onGetLinks,
  }: ResultsPaneProps,
) {
  const updatingFlights = updatingKinds.includes('flights')
  const updatingHotels = updatingKinds.includes('hotels')
  const newestFlights = newestOfKind(results, 'flights')
  const newestHotels = newestOfKind(results, 'hotels')

  // M4: the filter controls used to start empty whatever the row said, so after a TYPED filter
  // they rendered unselected while the list below them was narrowed — two different stories
  // about the same list. `ResultsView.filter` is the row's own filter, so the bar starts from it.
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

  // Section 7: what Jev found wrong drops out of the list and into the collapsed section under
  // it, and the tabs count only what is left. An unchecked row splits to "everything matched",
  // which is why `UncheckedNote` says in words that nothing was checked.
  const { matched: flightMatched, unmatched: flightUnmatched } =
    splitByVerdict(flightItems, newestFlights?.verdicts)
  const { matched: hotelMatched, unmatched: hotelUnmatched } =
    splitByVerdict(hotelItems, newestHotels?.verdicts)
  const flightMatchChips = matchesBySourceId(newestFlights?.verdicts)
  const hotelMatchChips = matchesBySourceId(newestHotels?.verdicts)

  // Pass 3, section 6a: her click counts as chosen immediately, exactly as the proposal row
  // will once it lands. The proposal wins when both exist — it is the server's own answer.
  const pendingFlight = pendingChoice?.kind === 'flight' ? pendingChoice.sourceId : null
  const pendingHotel = pendingChoice?.kind === 'hotel' ? pendingChoice.sourceId : null
  const chosenFlightSourceId = proposal?.items.find((i) => i.kind === 'flight')?.sourceId ?? pendingFlight
  const chosenHotelSourceId = proposal?.items.find((i) => i.kind === 'hotel')?.sourceId ?? pendingHotel
  const hasChosen = proposal !== null && proposal.items.length > 0
  // Every OTHER card's Select goes dead while a choice is in flight: one press is one
  // instruction, and a second one would be refused with a 409 anyway (`submitAction`).
  const choosing = pendingChoice !== null
  const pendingItem = pendingChoice === null
    ? null
    : itemById(pendingChoice.kind === 'flight' ? newestFlights : newestHotels, pendingChoice.sourceId)

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

      {/* Pass 3, section 6a: the pinned block for a choice the server has not confirmed yet. It
          stands in for `PinnedSummary` above, never beside it. */}
      {!hasChosen && pendingItem && pendingChoice ? (
        <PendingPinned item={pendingItem} kind={pendingChoice.kind} />
      ) : null}

      {/* The placeholder for what the office does next with her choice: hotels after a flight,
          the trip summary after a hotel. The server's own `skeleton` says the same thing one
          round trip later, so whichever arrives first renders the same shape. */}
      {skeleton === 'hotels' || pendingChoice?.kind === 'flight' ? <ResultsSkeleton kind="hotels" /> : null}
      {pendingChoice?.kind === 'hotel' ? <PendingTripSummary /> : null}

      {newestHotels ? (
        <section className="results-section" aria-label="Hotels">
          <SummaryBar {...summaryBarPropsFor(newestHotels)} />
          <FilterBar
            kind="hotels" items={newestHotels.items}
            filter={hotelState.filter} onChange={setHotelFilter}
          />
          {/* The tabs summarise the MATCHED list: a tab advertising the price of a stay that is
              hidden in the collapsed section below is the row claiming a lead it is not
              offering — the same fault pass 3 fixed for the updating case. */}
          <SortTabs
            items={hotelMatched} sorts={HOTEL_SORTS}
            active={hotelState.sort} updating={updatingHotels} onChange={setHotelSort}
          />
          {newestHotels.verdicts ? null : <UncheckedNote />}
          <HotelList
            items={hotelMatched}
            adults={newestHotels.query.adults}
            now={now}
            chosenSourceId={chosenHotelSourceId}
            selectDisabled={choosing}
            updating={updatingHotels}
            matchesBySourceId={hotelMatchChips}
            onChoose={(sourceId) => onChoose('hotel', sourceId)}
          />
          {hotelUnmatched.length > 0 && newestHotels.verdicts ? (
            <UnmatchedSection kind="hotels" items={hotelUnmatched} verdicts={newestHotels.verdicts}>
              <HotelList
                items={hotelUnmatched}
                adults={newestHotels.query.adults}
                now={now}
                chosenSourceId={chosenHotelSourceId}
                selectDisabled={choosing}
                updating={updatingHotels}
                matchesBySourceId={hotelMatchChips}
                onChoose={(sourceId) => onChoose('hotel', sourceId)}
              />
            </UnmatchedSection>
          ) : null}
        </section>
      ) : null}

      {newestFlights ? (
        <section className="results-section" aria-label="Flights">
          <SummaryBar {...summaryBarPropsFor(newestFlights)} />
          <FilterBar
            kind="flights" items={newestFlights.items}
            filter={flightState.filter} onChange={setFlightFilter}
          />
          <SortTabs
            items={flightMatched} sorts={FLIGHT_SORTS}
            active={flightState.sort} updating={updatingFlights} onChange={setFlightSort}
          />
          {newestFlights.verdicts ? null : <UncheckedNote />}
          <FlightList
            items={flightMatched}
            adults={newestFlights.query.adults}
            now={now}
            chosenSourceId={chosenFlightSourceId}
            selectDisabled={choosing}
            updating={updatingFlights}
            matchesBySourceId={flightMatchChips}
            onChoose={(sourceId) => onChoose('flight', sourceId)}
          />
          {flightUnmatched.length > 0 && newestFlights.verdicts ? (
            <UnmatchedSection kind="flights" items={flightUnmatched} verdicts={newestFlights.verdicts}>
              <FlightList
                items={flightUnmatched}
                adults={newestFlights.query.adults}
                now={now}
                chosenSourceId={chosenFlightSourceId}
                selectDisabled={choosing}
                updating={updatingFlights}
                matchesBySourceId={flightMatchChips}
                onChoose={(sourceId) => onChoose('flight', sourceId)}
              />
            </UnmatchedSection>
          ) : null}
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
  /** `conversations.status` — the one guard on the background refresh; see `shouldAutoRefresh`. */
  status: string
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
export function ResultsPaneLive(
  { conversationId, results, proposal, skeleton = null, status }: ResultsPaneLiveProps,
) {
  const router = useRouter()
  const activity = useActivity()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingChoice, setPendingChoice] = useState<PendingChoice | null>(null)
  const [updatingKinds, setUpdatingKinds] = useState<('flights' | 'hotels')[]>([])
  /**
   * Every `results` row this instance has already fired a background refresh for, by
   * `messageId`. A ref, not state: it must not cause a render, and it must survive both the
   * re-render `router.refresh()` causes and React's Strict Mode running the effect below twice
   * on the same instance — either of which would otherwise fire a second supplier call (which
   * `submitAction` would refuse with a 409 anyway, leaving a skeleton that never fills).
   *
   * Never cleared. One row is re-run at most once per page; if that re-run fails, the correction
   * is explicit about there being no retry.
   */
  const autoRefreshed = useRef<Set<string>>(new Set())

  /**
   * Pass 3, section 6: `rollback` runs on every path that leaves the screen claiming something
   * the server did not do — a non-200 response (see `outcomeForStatus`) or a thrown fetch. On a
   * 200 the optimistic state is LEFT in place and `router.refresh()` replaces it with the
   * server's identical own, so nothing jumps in between.
   */
  async function post(path: string, body: unknown, rollback?: () => void) {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok || outcomeForStatus(res.status) === 'rollback') {
        setError(errorForStatus(res.status))
        rollback?.()
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
      rollback?.()
    } finally {
      setPending(false)
    }
  }

  function rollbackChoice() {
    setPendingChoice(null)
    activity.setBusy(false)
  }

  /**
   * The background refresh (pass 3, the author's correction to section 1). Fired from an effect
   * rather than from an event, because nothing she did started it: the page simply loaded onto a
   * row whose prices have expired.
   *
   * On success nothing is done here at all — no `router.refresh()`. The turn it queued flips the
   * conversation to `working`, which `ThreadLive`'s Realtime subscription already refreshes on,
   * and the new `results` row arrives through the same path every other row does. The price
   * skeletons stay up until it does, because they are keyed on the row still being stale.
   *
   * On failure the skeletons come down and the OLD prices come back with their age text, which
   * is the honest answer: these are the numbers we have, and this is how old they are.
   */
  async function autoRefresh(kind: 'flights' | 'hotels') {
    setUpdatingKinds((current) => (current.includes(kind) ? current : [...current, kind]))
    activity.setUpdating(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      if (res.ok) return
    } catch {
      // Same answer as a refused response: fall through to putting the old prices back.
    }
    setUpdatingKinds((current) => current.filter((k) => k !== kind))
    activity.setUpdating(false)
  }

  useEffect(() => {
    for (const kind of ['flights', 'hotels'] as const) {
      const view = newestOfKind(results, kind)
      if (!view || !shouldAutoRefresh(view, status)) continue
      if (autoRefreshed.current.has(view.messageId)) continue
      autoRefreshed.current.add(view.messageId)
      void autoRefresh(kind)
    }
    // `autoRefresh` closes over nothing but the setters, `activity` and `conversationId`, all of
    // which are stable for a given mounted conversation; the rows and the status are what decide
    // whether it should run at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, status])

  // The refreshed row has landed (it is no longer stale), so the skeletons have nothing left to
  // stand for and the status line goes back to what the conversation actually says.
  const stillStale = updatingKinds.some((kind) => newestOfKind(results, kind)?.stale === true)
  useEffect(() => {
    if (updatingKinds.length > 0 && !stillStale) {
      setUpdatingKinds([])
      activity.setUpdating(false)
    }
  }, [updatingKinds, stillStale, activity])

  return (
    <ResultsPane
      results={results}
      proposal={proposal}
      skeleton={skeleton}
      pending={pending}
      error={error}
      pendingChoice={pendingChoice}
      updatingKinds={updatingKinds}
      onChoose={(kind, sourceId) => {
        // Before the fetch, deliberately: this is the whole of section 6a.
        setPendingChoice({ kind, sourceId })
        activity.setBusy(true)
        void post(`/api/conversations/${conversationId}/choose`, { kind, sourceId }, rollbackChoice)
      }}
      onGetLinks={() => {
        if (!proposal || proposal.decision !== null) return
        // `pending` (set first thing in `post`, synchronously) is what turns the button into
        // "Checking prices…" — see `PinnedSummary`.
        activity.setBusy(true)
        void post(`/api/proposals/${proposal.id}/decide`, { decision: 'accept' }, () => activity.setBusy(false))
      }}
    />
  )
}
