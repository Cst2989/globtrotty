/**
 * Pass 3, section 1: "Refresh prices". A `refresh` action (src/actions.ts) is written when she
 * presses the button on the stale banner the results pane now puts above an aged-out list
 * (`ResultsView.stale`, web/data.ts) — `handleRefresh` runs as the agent for the fresh turn
 * `submitAction` queued for it (src/agents/router.ts dispatches a newest-row `refresh` action
 * here, never to the driver).
 *
 * It re-runs the search she already had, nothing more: the newest UNFILTERED `results` row of
 * that kind is the source of truth for WHAT to search (unfiltered for the same reason a typed
 * filter reads that row — the final review's I1 — and because a refresh must be able to come
 * back with flights an earlier filter had hidden), the supplier call goes through the same
 * budget/begin/finish/record door as `src/agents/intake.ts`'s, flights are re-ranked by Jev the
 * same way, and the reply carries a fresh `results` attachment with the SAME query and the SAME
 * assumptions. Nothing about the trip is re-interpreted, so there is no intake Jev call here and
 * no notebook write: a price refresh is not a new brief.
 *
 * Trust boundary: every sentence below is fixed English chosen by this file. The stored `query`
 * supplies codes and ISO dates to the SUPPLIER, never a word of prose to her or to the model.
 */
import type postgres from 'postgres'
import type { AgentContext, AgentStep } from '../worker.js'
import type { IntakeDeps } from './intake.js'
import { kiwiCabin } from './intake.js'
import { nextStepsAttachment } from './nextSteps.js'
import { rankItems } from '../intake/rank.js'
import { recordJevCall } from '../jev/record.js'
import { readLatestUnfilteredResults } from '../repo/messages.js'
import { loadNotebook } from '../repo/notebook.js'
import { recordResults, rehydrate } from '../repo/toolResults.js'
import { recordSpend } from '../repo/spend.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { beginToolCall, finishToolCall } from '../repo/toolCalls.js'
import type { ResultsContent } from '../results.js'
import type { TripBrief } from '../intake/brief.js'
import type { FlightSearch, HotelSearch, SearchParams, SupplierItem } from '../supplier/types.js'

/** The router's own shape for a `refresh` action; `action` has already done its job by now. */
export type RefreshAction = { kind: 'flight' | 'hotel' }

/** Same marker class as intake's: the one thing the catch below has to tell apart. */
class RefreshSupplierError extends Error {}

/** No stored search of that kind to re-run — a forged or very stale press. Costs nothing to refuse. */
const NOTHING_TO_REFRESH = 'I do not have a search to refresh. Tell me the trip again.'

const REFRESHED = 'Prices refreshed.'

/**
 * A search that worked a quarter of an hour ago and comes back empty now is almost always a
 * transient supplier answer, so the words point at the two things that actually help rather
 * than at a problem she caused.
 */
const ZERO_ITEMS = 'Nothing came back this time. Try again in a minute or change the dates.'

const SUPPLIER_FAILED = 'I could not reach the search just now. Please try again in a moment.'
const OTHER_FAILED = 'Something went wrong while refreshing those prices. Please try again.'

/**
 * The `FlightSearch` a stored flights row implies. The same mapping `runIntakeTurn` does from a
 * `TripBrief`, read off `ResultsContent.query` instead — which carries every field of it but
 * two:
 *
 * - `maxStops`: the brief's own value is never written to a `results` row (nor to the notebook),
 *   so this sends `null`. A refresh can therefore come back with a connection-heavy itinerary
 *   the original search would have excluded; the pane's own Stops filter is one click away, and
 *   inventing a cap here would be worse — it would silently hide fares she never asked to hide.
 * - `currency`: `'EUR'`, the same fixed value `runIntakeTurn` sends (its own recorded backlog
 *   item), so the refreshed prices are comparable with the ones they replace.
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
 * The `HotelSearch` a stored hotels row implies. `query.place` is what `handleChooseFlight` sent
 * as the supplier's own `query` string (its `hotelQueryName`, the place table's name — never a
 * supplier's or hers), and `outbound`/`inbound` are the check-in and check-out it recorded.
 * `currency` comes from the notebook, the same place that search read it from.
 */
export function hotelParamsFor(query: ResultsContent['query'], currency: string): HotelSearch | null {
  if (!query.place || !query.inbound) return null
  return {
    kind: 'hotel', query: query.place, checkIn: query.outbound, checkOut: query.inbound,
    adults: query.adults, currency,
  }
}

/**
 * Only six fields of a `TripBrief` are read by `rankItems` (`cabinLong`, `cabinShort`,
 * `maxStops`, `arriveBy`, `outbound`, `inbound`) and all six are recoverable from the stored
 * query, so the re-rank runs on the same preferences the original one did rather than on a
 * second, parallel notion of what she asked for. The rest is filled with the same defaults
 * `assembleBrief` uses, and never leaves this function.
 */
function briefForRank(query: ResultsContent['query']): TripBrief {
  const cabin = query.cabin ?? 'economy'
  return {
    origin: query.from ?? '', destination: query.to ?? '', sideTrip: null,
    outbound: query.outbound, inbound: query.inbound, adults: query.adults,
    cabinLong: cabin, cabinShort: cabin, maxStops: null,
    hotels: false, arriveBy: false, assumptions: [],
  }
}

/**
 * begin -> run -> finish around the one supplier call, exactly `runIntakeTurn`'s block: intent
 * persisted before the external effect is what makes a kill-and-resume safe, and the replay path
 * rebuilds from the durable corpus rather than from the `tool_calls` row (whose JSON could never
 * carry a bigint price). The call id is a fixed literal per kind — a refresh turn searches at
 * most once, and `(turn_id, call_id)` only has to be unique WITHIN the turn.
 */
async function search(
  deps: IntakeDeps, ctx: AgentContext, params: SearchParams,
): Promise<SupplierItem[]> {
  const { sql } = deps
  const flights = params.kind === 'flight'
  const callId = flights ? 'refresh-flights' : 'refresh-hotels'
  const begun = await beginToolCall(sql, ctx.turnId, callId, flights ? 'explore_flights' : 'explore_hotels')
  if (begun.status === 'ambiguous') {
    throw new RefreshSupplierError('refresh: a previous attempt at this search did not finish')
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
    items = params.kind === 'flight' ? await deps.flights.search(params) : await deps.hotels.search(params)
  } catch (err) {
    throw new RefreshSupplierError(err instanceof Error ? err.message : String(err))
  }
  await finishToolCall(sql, ctx.turnId, callId, { sourceIds: items.map((i) => i.sourceId) })
  return items
}

/** The notebook's own currency for a hotel search, same fallback `handleChooseFlight` uses. */
async function hotelCurrency(sql: postgres.Sql, ctx: AgentContext): Promise<string> {
  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  return notebook.budget === null ? 'EUR' : notebook.budget.value.currency
}

export async function handleRefresh(
  deps: IntakeDeps, ctx: AgentContext, action: RefreshAction,
): Promise<AgentStep> {
  const { sql } = deps
  const rowKind = action.kind === 'flight' ? 'flights' : 'hotels'
  const base = await readLatestUnfilteredResults(sql, ctx.conversationId, ctx.userId, rowKind)
  if (!base) return { kind: 'park', message: NOTHING_TO_REFRESH, costMicros: 0n }

  const params = action.kind === 'flight'
    ? flightParamsFor(base.query)
    : hotelParamsFor(base.query, await hotelCurrency(sql, ctx))
  // A stored row whose query cannot be turned back into a supplier call (a flights row with no
  // `from`, a hotels row with no check-out) is a shape this office never writes; refusing reads
  // the same as having nothing to refresh, and costs nothing either.
  if (!params) return { kind: 'park', message: NOTHING_TO_REFRESH, costMicros: 0n }

  let cost = 0n
  try {
    // Spec §1.4: a direct supplier call counts against the same per-turn budget
    // `explore_flights`/`explore_hotels` do, read through the same door.
    const budget = await assertSupplierBudget(sql, ctx.turnId, deps.limits.maxSupplierCallsPerTurn)
    if (!budget.ok) {
      return {
        kind: 'fail', reason: 'limit_reached',
        message: `You have used all ${budget.max} supplier searches for this turn `
          + `(${budget.used} so far). Please try again in a moment.`,
        recordedMicros: 0n,
      }
    }

    const items = await search(deps, ctx, params)

    // Hotels are not re-ranked, here or in `handleChooseFlight`: `rankItems` scores flight
    // itineraries against flight preferences and throws on anything else.
    const ranked = action.kind === 'flight' && items.length > 1
      ? await rankItems({ jev: deps.jev }, briefForRank(base.query), items)
      : { ordered: items, request: null, response: null }

    if (ranked.response) {
      cost += await recordJevCall(sql, {
        conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
        seat: 'rerank', request: ranked.request!, response: ranked.response,
      })
    }

    await recordResults(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
    })

    // M1's rule: `recordResults` short-circuits on an empty list, so a row naming an empty
    // corpus would name nothing. No attachment, its own sentence, and the two chips that can
    // turn an empty search into a full one.
    if (items.length === 0) {
      return {
        kind: 'park', message: ZERO_ITEMS, costMicros: cost,
        attachments: [nextStepsAttachment(action.kind === 'flight' ? 'zero_flights' : 'zero_hotels')],
      }
    }

    return {
      kind: 'park', message: REFRESHED, costMicros: cost,
      attachments: [
        {
          role: 'results',
          content: {
            kind: rowKind,
            query: base.query,
            sourceIds: ranked.ordered.slice(0, 10).map((i) => i.sourceId),
            assumptions: base.assumptions,
            refreshed: true,
          },
        },
        nextStepsAttachment(action.kind === 'flight' ? 'flights' : 'hotels'),
      ],
    }
  } catch (err) {
    // Same hand-debit as `runIntakeTurn`'s catch: a `fail` step carries no `costMicros` for the
    // worker to debit, so whatever the re-rank call has cost so far is debited here, once.
    await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: cost })
    return {
      kind: 'fail',
      reason: err instanceof RefreshSupplierError ? 'provider_down' : 'fetch_failed',
      message: err instanceof RefreshSupplierError ? SUPPLIER_FAILED : OTHER_FAILED,
      recordedMicros: cost,
    }
  }
}
