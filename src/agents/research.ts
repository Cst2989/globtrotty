/**
 * Polish pass, sections 2 and 7: re-running a search this office has already run, in ONE place.
 *
 * Three callers needed the same six steps — work out what to search for, check the per-turn
 * supplier budget, go through begin/finish `tool_calls`, stamp the stays with their distance
 * from the centre, write the corpus row, and have Jev re-rank the result — and each had grown
 * its own copy:
 *
 *  - `handleRefresh` (src/agents/refresh.ts) rebuilt a hotels query out of the stored row, which
 *    is how a Tokyo list came back as vacation rentals in the United States: the row it was
 *    reading predated the fix and still said `q = NRT`.
 *  - `handleChooseFlight` (src/agents/choose.ts) ran its own copy for the hotels that follow a
 *    flight.
 *  - Section 7's re-quote, which has to re-run a search before a Select is allowed to stand on
 *    an expired price, had nothing to call at all.
 *
 * So the plan — what to search for — is computed from the CONVERSATION's own state rather than
 * from whichever row happens to be newest, and the run is one function. A hotels plan is built
 * from the chosen flight's destination and window (`stayWindowForFlight`, src/agents/hotels.ts
 * — the same path `handleChooseFlight` uses), and falls back to the stored row only when no
 * flight has been chosen yet.
 *
 * Trust boundary: every string that reaches a supplier here comes from this repo's own bundled
 * place table or from an ISO date already parsed by `ResultsContentSchema`. Nothing the
 * traveller typed and nothing a supplier wrote is interpolated into a query.
 */
import type postgres from 'postgres'
import type { AgentContext } from '../worker.js'
import type { IntakeDeps } from './intake.js'
import { kiwiCabin } from './intake.js'
import { rankItems } from '../intake/rank.js'
import { hotelQuery, placeByName, type Place } from '../intake/places.js'
import { hotelSearchFor, stayWindowForFlight, withDistanceFromCentre } from './hotels.js'
import { recordJevCall } from '../jev/record.js'
import { readLatestResults, readLatestUnfilteredResults } from '../repo/messages.js'
import { loadNotebook } from '../repo/notebook.js'
import { loadNewestAcceptedItinerary } from '../repo/proposals.js'
import { recordResults, rehydrate } from '../repo/toolResults.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { beginToolCall, finishToolCall } from '../repo/toolCalls.js'
import type { Assumption, ResultsContent } from '../results.js'
import type { TripBrief } from '../intake/brief.js'
import { isFlight, type FlightSearch, type HotelSearch, type SearchParams, type SupplierItem } from '../supplier/types.js'

/** Thrown when the SUPPLIER failed, which is the one failure a caller answers differently. */
export class ResearchSupplierError extends Error {}

export type RowKind = ResultsContent['kind']

export type Verdicts = Record<string, { matches: string[]; issues: string[] }>

/**
 * Everything one re-run needs: what to ask the supplier, what the `results` row it produces
 * should say, and what the re-rank should score against.
 */
export type SearchPlan = {
  rowKind: RowKind
  params: SearchParams
  /** Hotels only: the destination whose centre the distances are measured from. */
  place: Place | null
  query: ResultsContent['query']
  assumptions: Assumption[]
  brief: TripBrief
}

export type RerunResult =
  | { status: 'ok'; ordered: SupplierItem[]; verdicts: Verdicts | null; cost: bigint }
  | { status: 'zero'; cost: bigint }
  | { status: 'budget'; max: number; used: number }

/**
 * The `FlightSearch` a stored flights row implies. The same mapping `runIntakeTurn` does from a
 * `TripBrief`, read off `ResultsContent.query` instead — which carries every field of it but
 * two:
 *
 * - `maxStops`: the brief's own value is never written to a `results` row (nor to the notebook),
 *   so this sends `null`. A re-run can therefore come back with a connection-heavy itinerary the
 *   original search would have excluded; the pane's own Stops filter is one click away, and
 *   inventing a cap here would be worse — it would silently hide fares she never asked to hide.
 * - `currency`: `'EUR'`, the same fixed value `runIntakeTurn` sends (its own recorded backlog
 *   item), so the re-quoted prices are comparable with the ones they replace.
 */
export function flightParamsFor(query: ResultsContent['query']): FlightSearch | null {
  if (!query.from || !query.to) return null
  return {
    kind: 'flight', from: query.from, to: query.to,
    departureDate: query.outbound, returnDate: query.inbound, flexDays: 0,
    adults: query.adults, children: 0, infants: 0,
    cabinClass: kiwiCabin(query.cabin ?? 'economy'),
    currency: 'EUR',
    maxStops: null, allowSelfTransfer: false,
  }
}

/**
 * The `HotelSearch` a stored hotels row implies — the LAST resort, used only when no flight has
 * been chosen and so no destination can be derived from one.
 *
 * `query.place` is the place table's own `hotelName` and `query.country` its ISO2; `hotelQuery`
 * turns the pair back into the exact `q` the original search sent. A row written before the
 * hotels pass carries neither, and `placeByName` then returns nothing — which is the whole
 * reason a plan prefers the chosen flight over this.
 */
export function hotelParamsFor(query: ResultsContent['query'], currency: string): HotelSearch | null {
  if (!query.place || !query.inbound) return null
  const countryCode = query.country ?? null
  return {
    kind: 'hotel', query: hotelQuery(query.place, countryCode),
    checkIn: query.outbound, checkOut: query.inbound,
    adults: query.adults, currency, countryCode,
  }
}

/**
 * Only six fields of a `TripBrief` are read when `rankItems` scores an ITINERARY (`cabinLong`,
 * `cabinShort`, `maxStops`, `arriveBy`, `outbound`, `inbound`) and three when it scores a STAY,
 * and all of them are recoverable from a stored query — so a re-rank runs on the same
 * preferences the original one did rather than on a second, parallel notion of what she asked
 * for. The rest is `assembleBrief`'s own defaults, and never leaves this module.
 */
function briefFor(query: ResultsContent['query']): TripBrief {
  const cabin = query.cabin ?? 'economy'
  return {
    origin: query.from ?? '', destination: query.to ?? query.place ?? '', sideTrip: null,
    outbound: query.outbound, inbound: query.inbound, adults: query.adults,
    cabinLong: cabin, cabinShort: cabin, maxStops: null,
    hotels: false, arriveBy: false, assumptions: [],
  }
}

/** The notebook's own currency, the same fallback `handleChooseFlight` uses. */
async function hotelCurrency(sql: postgres.Sql, ctx: AgentContext): Promise<string> {
  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  return notebook.budget === null ? 'EUR' : notebook.budget.value.currency
}

/**
 * The stay search the CHOSEN FLIGHT implies, or `null` when nothing is chosen yet (or the
 * arrival airport is one the place table does not carry).
 *
 * This is section 2's fix in one function. The hotels row on the author's screen was written
 * before `handleChooseFlight` learned to resolve an airport to a metro, so its `query` said
 * `NRT` and a refresh rebuilt from it searched SearchApi for "NRT" — which comes back with
 * vacation rentals in Colorado. The chosen flight is the durable, correct source for the
 * destination and the window, and it is the one `handleChooseFlight` itself reads, so a refresh
 * built from it can never again disagree with the search it claims to be refreshing.
 */
export async function hotelPlanFromChosenFlight(
  deps: IntakeDeps, ctx: AgentContext,
): Promise<SearchPlan | null> {
  const { sql } = deps
  const itinerary = await loadNewestAcceptedItinerary(sql, ctx.conversationId)
  const flightSourceId = itinerary?.items.find((i) => i.slot === 'flight')?.sourceId ?? null
  if (!flightSourceId) return null

  const stored = await rehydrate(sql, ctx.conversationId, [flightSourceId])
  const flight = stored.get(flightSourceId)
  if (!flight || !isFlight(flight)) return null

  const window = stayWindowForFlight(flight.detail)
  if (window === null) return null

  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  const latest = await readLatestResults(sql, ctx.conversationId, ctx.userId)
  const adults = notebook.partySize?.value.adults ?? latest?.query.adults ?? 1
  const currency = notebook.budget === null ? 'EUR' : notebook.budget.value.currency

  const query: ResultsContent['query'] = {
    place: window.place.hotelName,
    country: window.place.country,
    outbound: window.checkIn,
    inbound: window.checkOut,
    adults,
  }
  return {
    rowKind: 'hotels',
    params: hotelSearchFor({ place: window.place, checkIn: window.checkIn, checkOut: window.checkOut, adults, currency }),
    place: window.place,
    query,
    assumptions: [],
    brief: briefFor(query),
  }
}

/**
 * What to re-run for one kind, or `null` when this conversation holds nothing to re-run.
 *
 * Flights come off the newest UNFILTERED flights row — unfiltered for the same reason a typed
 * filter reads that row, and because a re-run must be able to come back with fares an earlier
 * filter had hidden. Hotels prefer the chosen flight and fall back to the stored row.
 */
export async function planFor(
  deps: IntakeDeps, ctx: AgentContext, kind: 'flight' | 'hotel',
): Promise<SearchPlan | null> {
  const { sql } = deps
  if (kind === 'hotel') {
    const fromFlight = await hotelPlanFromChosenFlight(deps, ctx)
    if (fromFlight) return fromFlight
  }

  const rowKind: RowKind = kind === 'flight' ? 'flights' : 'hotels'
  const base = await readLatestUnfilteredResults(sql, ctx.conversationId, ctx.userId, rowKind)
  if (!base) return null

  const params = kind === 'flight'
    ? flightParamsFor(base.query)
    : hotelParamsFor(base.query, await hotelCurrency(sql, ctx))
  // A stored row whose query cannot be turned back into a supplier call (a flights row with no
  // `from`, a hotels row with no check-out) is a shape this office never writes; refusing reads
  // the same as having nothing to re-run, and costs nothing either.
  if (!params) return null

  return {
    rowKind,
    params,
    place: kind === 'hotel' && base.query.place ? placeByName(base.query.place) : null,
    query: base.query,
    assumptions: base.assumptions,
    brief: briefFor(base.query),
  }
}

/**
 * begin -> run -> finish around the one supplier call, exactly `runIntakeTurn`'s block: intent
 * persisted before the external effect is what makes a kill-and-resume safe, and the replay path
 * rebuilds from the durable corpus rather than from the `tool_calls` row (whose JSON could never
 * carry a bigint price). `callId` is a fixed literal per call site — `(turn_id, call_id)` only
 * has to be unique WITHIN the turn, and a turn runs each of these at most once.
 */
async function search(
  deps: IntakeDeps, ctx: AgentContext, params: SearchParams, callId: string,
): Promise<SupplierItem[]> {
  const { sql } = deps
  const flights = params.kind === 'flight'
  const begun = await beginToolCall(sql, ctx.turnId, callId, flights ? 'explore_flights' : 'explore_hotels')
  if (begun.status === 'ambiguous') {
    throw new ResearchSupplierError(`${callId}: a previous attempt at this search did not finish`)
  }
  if (begun.status === 'replayed') {
    const sourceIds = (begun.result as { sourceIds: string[] }).sourceIds
    const rehydrated = await rehydrate(sql, ctx.conversationId, sourceIds)
    return sourceIds.flatMap((id) => {
      const item = rehydrated.get(id)
      return item ? [item] : []
    })
  }
  let items: SupplierItem[]
  try {
    items = flights
      ? await deps.flights.search(params as FlightSearch)
      : await deps.hotels.search(params as HotelSearch)
  } catch (err) {
    throw new ResearchSupplierError(err instanceof Error ? err.message : String(err))
  }
  await finishToolCall(sql, ctx.turnId, callId, { sourceIds: items.map((i) => i.sourceId) })
  return items
}

/**
 * Run one plan: budget, supplier, distances, corpus, re-rank. Throws `ResearchSupplierError`
 * when the supplier failed and anything else when the bookkeeping did, which is the distinction
 * every caller's catch is already built around.
 *
 * BOTH kinds are re-ranked. A hotels row left in SearchApi's own relevance order is six vacation
 * rentals before the first real hotel, and a row with no `verdicts` renders under "Not checked
 * against your request" — which is exactly what the author saw. A list too short to re-rank was
 * never checked either, and `null` is how that is said.
 */
export async function rerunSearch(
  deps: IntakeDeps, ctx: AgentContext, plan: SearchPlan, callId: string,
): Promise<RerunResult> {
  const { sql } = deps
  // Spec section 1.4: a direct supplier call counts against the same per-turn budget
  // `explore_flights`/`explore_hotels` do, read through the same door.
  const budget = await assertSupplierBudget(sql, ctx.turnId, deps.limits.maxSupplierCallsPerTurn)
  if (!budget.ok) return { status: 'budget', max: budget.max, used: budget.used }

  const found = await search(deps, ctx, plan.params, callId)
  // The stays get their distance from the centre stamped on exactly as the original search did
  // (`handleChooseFlight`), from the plan's own place — otherwise a re-run would quietly drop
  // "3.2 km from centre" off every card.
  const items = plan.place === null ? found : withDistanceFromCentre(found, plan.place)

  let cost = 0n
  let ordered = items
  let verdicts: Verdicts | null = null
  if (items.length > 1) {
    // A re-rank failure is not a run failure: the results are real, so the supplier's own order
    // is shown rather than nothing. Same decision `handleChooseFlight` already made.
    try {
      const ranked = await rankItems({ jev: deps.jev }, plan.brief, items)
      ordered = ranked.ordered
      verdicts = ranked.verdicts
      if (ranked.response) {
        cost += await recordJevCall(sql, {
          conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
          seat: 'rerank', request: ranked.request!, response: ranked.response,
        })
      }
    } catch {
      ordered = items
      verdicts = null
    }
  }

  await recordResults(sql, {
    conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId,
    params: plan.params, items,
  })

  // `recordResults` short-circuits on an empty list, so a row naming an empty corpus would name
  // nothing at all. The caller answers that case with its own sentence and no attachment.
  if (items.length === 0) return { status: 'zero', cost }
  return { status: 'ok', ordered, verdicts, cost }
}

/** The `results` attachment one finished re-run produces. */
export function resultsAttachment(
  plan: SearchPlan, run: { ordered: SupplierItem[]; verdicts: Verdicts | null },
  extra: { refreshed?: boolean; limit?: number } = {},
): { role: 'results'; content: ResultsContent } {
  const ids = run.ordered.map((i) => i.sourceId)
  return {
    role: 'results',
    content: {
      kind: plan.rowKind,
      query: plan.query,
      sourceIds: extra.limit === undefined ? ids : ids.slice(0, extra.limit),
      assumptions: plan.assumptions,
      ...(extra.refreshed ? { refreshed: true } : {}),
      ...(run.verdicts ? { verdicts: run.verdicts } : {}),
    },
  }
}
