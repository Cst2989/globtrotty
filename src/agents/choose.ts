/**
 * Plan 5 Task 7: the Choose button. A `choose` action (src/actions.ts) names a
 * card she clicked out of a `results` row (src/results.ts) — `handleChoose`
 * runs as the agent for the fresh turn `submitAction` queued for it
 * (src/agents/router.ts dispatches a newest-row `choose` action here, never
 * to the driver).
 *
 * Choosing a FLIGHT records an accepted flights-only proposal (gates +
 * reviewer, through `runProposalPath` — the same path `propose_itinerary`
 * uses) and, once that lands, searches hotels for the destination and
 * window the chosen flight itself implies. Choosing a HOTEL records the
 * combined `[flight, stay]` proposal through the same gates/reviewer path
 * and leaves it UNDECIDED: "Get booking links" is the acceptance, not the
 * hotel click (ledger ruling on the final review's C4 — spec section 9
 * wins over plan Task 9's wiring). See `handleChooseHotel` for why.
 *
 * Trust boundary: nothing here embeds a supplier string into the message
 * she reads — `cityLabel`/`hotelQueryName` read only the bundled place
 * table's own fixed city/hotelName strings (src/intake/places.ts), never a
 * supplier-authored name, and the two fixed replies below carry no
 * traveller- or supplier-authored text at all.
 */
import type { AgentContext, AgentStep } from '../worker.js'
import type { IntakeDeps } from './intake.js'
import { runProposalPath } from './proposalPath.js'
import { nextStepsAttachment } from './nextSteps.js'
import { loadNotebook } from '../repo/notebook.js'
import { decideProposal, loadNewestAcceptedItinerary, loadNewestProposalForTurn } from '../repo/proposals.js'
import { rehydrate, recordResults } from '../repo/toolResults.js'
import { readLatestResults } from '../repo/messages.js'
import { countPriorGateRuns, beginToolCall, finishToolCall } from '../repo/toolCalls.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { type Place } from '../intake/places.js'
import { hotelSearchFor, stayWindowForFlight, withDistanceFromCentre } from './hotels.js'
import { ResearchSupplierError, planFor, rerunSearch, resultsAttachment } from './research.js'
import { cachedSearch, logCache } from './searchCache.js'
import { conversationStage, hotelsFoundReply, nextStepsForList } from './stage.js'
import { nightsBetween } from '../supplier/dates.js'
import { rankItems } from '../intake/rank.js'
import { recordJevCall } from '../jev/record.js'
import type { TripBrief } from '../intake/brief.js'
import { isFlight, isHotel, type StoredItem, type SupplierItem } from '../supplier/types.js'

/** The router's own shape for a `choose` action, matching Task 7's own documented interface —
 * the full `ActionPayload` carries `action: 'choose'` too, but that field has already done its
 * job (telling the router which handler to call) by the time it reaches this one. */
export type ChooseAction = { kind: 'flight' | 'hotel'; sourceId: string }

/**
 * The two reasons `runProposalPath` can reject, each with its own fixed sentence (M7: one
 * message said "price moved or expired" even for a reviewer `Revise:` verdict, which is a
 * different thing entirely and tells her to do the wrong thing about it).
 *
 * Still fixed text, same trust-boundary instinct as every other reply here: never the gate's or
 * reviewer's own prose, which already reaches the model's context in the driver's flow but has
 * no business reaching HER directly from a card press. `rejectionMessage` reads only the
 * PREFIX `runProposalPath` itself writes, never any of the text after it.
 */
const GATE_REJECTED_MESSAGE = 'That option no longer passes our checks (price moved or expired). Pick another.'
const REVIEW_REJECTED_MESSAGE = 'Our reviewer was not happy with that combination. Pick another option.'

/** `runProposalPath` returns `Revise: ...` for a reviewer verdict with rounds left, and
 * `The proposal was rejected. Fix exactly these...` for a gate fault. Those two prefixes are
 * ours, written by that function; anything else is treated as the gate case. */
function rejectionMessage(pathText: string): string {
  return pathText.startsWith('Revise:') ? REVIEW_REJECTED_MESSAGE : GATE_REJECTED_MESSAGE
}

/**
 * Returned when `runProposalPath` itself THREW rather than returning a verdict — the final
 * review's I2. `reviewOffer` refunds on its own throw, but `spent.micros` has already
 * accumulated the reviewer's cost by the time `countReviewerVerdicts`/`saveProposal` run
 * (src/agents/proposalPath.ts:43), and a throw there used to propagate out of `handleChoose` to
 * `runTurn`'s catch, where `failTurn(turnSpend.total)` never sees it. This is the same F4 bug
 * the driver's tool path fixed with a `finally` (src/worker.ts); the `choose` path had no
 * equivalent, so the fail arm below reports `spent.micros` on `recordedMicros`.
 *
 * Fixed text, same reason as the two rejection sentences above: never the thrown error's own
 * message.
 */
const PATH_FAILED_MESSAGE = 'I could not finish checking that option just now. Please try again in a moment.'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * 'two' for 2, '12' for 12.
 *
 * A party size is small and a sentence reads better with the word: "16 nights, two adults" is
 * how a person says it, and "16 nights, 2 adults" is how a form prints it. Past nine the digit
 * wins back, which is the ordinary convention and also where the words stop being shorter.
 * `PartySize` is capped at 20 by `ResultsContentSchema`, so there is no third case.
 */
const SMALL_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

export function countWord(n: number): string {
  return n >= 0 && n < SMALL_NUMBERS.length ? SMALL_NUMBERS[n]! : String(n)
}

/** 'D Mon' — e.g. '2026-11-20' -> '20 Nov'. Same shape as src/agents/intake.ts's own `dateLabel`
 * (not exported there, so duplicated here rather than reached across a module boundary that
 * exists for an unrelated reason). */
function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/**
 * The arrival airport could not be matched to a city this office can search hotels in
 * (`placeForAirport` returned null). The flight is still accepted, so this is a `park`, and it
 * deliberately does not echo the code back: a `LegSummary.to` is supplier-authored, and "hotels
 * in NRT" is the bug this whole pass exists to fix — printing the same code at her is no better.
 */
const UNKNOWN_DESTINATION_MESSAGE = 'Flight noted. I could not match that arrival airport to a city '
  + 'I can search hotels in. Tell me the area you want to stay in.'

/**
 * The preferences a hotel re-rank is scored against (src/intake/rank.ts). Only THREE fields of a
 * `TripBrief` reach a hotel option's scoring — `preferencesFor` there documents which, and why
 * `hotels`, `cabinLong` and `maxStops` are not among them — so every other field is filled with
 * `assembleBrief`'s own default and none of them leaves this function.
 */
function briefForHotelRank(args: { adults: number; checkIn: string; checkOut: string; place: Place }): TripBrief {
  return {
    origin: '', destination: args.place.code, sideTrip: null,
    outbound: args.checkIn, inbound: args.checkOut, adults: args.adults,
    cabinLong: 'economy', cabinShort: 'economy', maxStops: null,
    hotels: false, arriveBy: false, assumptions: [],
  }
}

/**
 * Polish pass, section 7: Select never goes dead.
 *
 * The author could not select ANY hotel. Every card on her screen was past its ttl, and an
 * expired card disabled its own Select with "Refresh prices first" — so the one list she had was
 * a list of buttons that did nothing, and the refresh that was supposed to rescue them had
 * quietly skipped that row. A disabled button is the office making its own bookkeeping her
 * problem; what she means by pressing Select is "I want this one", and the honest answer to a
 * price we are no longer sure of is to go and ask again.
 *
 * So the button stays live (web/components/HotelCard.tsx, FlightCard.tsx) and the handler does
 * the work: an expired quote is re-searched FIRST, through the same budget/`tool_calls`/corpus
 * door every other search in this office goes through. If the same `sourceId` comes back fresh,
 * nothing else changes — the normal choose flow continues with the new quote, and the gates see
 * a price they can approve. If it does not, she gets the updated list and one sentence saying
 * why, instead of a gate rejection about provenance.
 *
 * Falling back to the stale item is deliberate on every path that is not "it is gone": no plan
 * to re-run, a supplier that would not answer, an empty answer, an exhausted per-turn budget.
 * The freshness gate (src/tools/gate.ts) is downstream of all of them and refuses an expired
 * price in its own words; this function exists to AVOID that, not to duplicate it.
 */
const REQUOTE_GONE = 'That one is no longer available at that price. Here is the updated list.'

/** Past its own ttl, by the same arithmetic the freshness gate and `loadResults` both use. */
function pastTtl(item: StoredItem, now: Date): boolean {
  return item.fetchedAt.getTime() + item.ttlSeconds * 1000 < now.getTime()
}

type Chosen =
  /** Go on with this item; `cost` is whatever a re-quote spent getting it. */
  | { status: 'ok'; item: StoredItem; cost: bigint }
  /** Answer with this step instead. */
  | { status: 'step'; step: AgentStep }

async function quoteForChoice(
  deps: IntakeDeps, ctx: AgentContext, kind: 'flight' | 'hotel', sourceId: string, missing: string,
): Promise<Chosen> {
  const { sql } = deps
  const ofKind = kind === 'flight' ? isFlight : isHotel
  const stored = await rehydrate(sql, ctx.conversationId, [sourceId])
  const item = stored.get(sourceId)
  if (!item || !ofKind(item)) {
    return { status: 'step', step: { kind: 'park', message: missing, costMicros: 0n } }
  }

  const now = new Date(deps.now())
  if (!pastTtl(item, now)) return { status: 'ok', item, cost: 0n }

  const plan = await planFor(deps, ctx, kind)
  if (!plan) return { status: 'ok', item, cost: 0n }

  let run
  try {
    run = await rerunSearch(deps, ctx, plan, kind === 'flight' ? 'requote-flights' : 'requote-hotels')
  } catch (err) {
    // A supplier that will not answer is not a reason to refuse her press. `ResearchSupplierError`
    // and a bookkeeping throw are treated alike here for once: either way the only quote this
    // office has is the one it already had, and the gates are what decide whether it stands.
    void (err instanceof ResearchSupplierError)
    return { status: 'ok', item, cost: 0n }
  }
  if (run.status !== 'ok') return { status: 'ok', item, cost: 0n }

  const after = await rehydrate(sql, ctx.conversationId, [sourceId])
  const fresh = after.get(sourceId)
  if (fresh && ofKind(fresh) && !pastTtl(fresh, now)) {
    return { status: 'ok', item: fresh, cost: run.cost }
  }

  const stage = await conversationStage(sql, ctx.conversationId, ctx.userId)
  return {
    status: 'step',
    step: {
      kind: 'park', message: REQUOTE_GONE, costMicros: run.cost,
      attachments: [
        resultsAttachment(plan, run, { limit: 10 }),
        nextStepsAttachment(nextStepsForList(stage, plan.rowKind)),
      ],
    },
  }
}

/**
 * Choosing a flight: a flights-only proposal through the gates and the
 * reviewer, accepted, then a hotel search for the window the chosen flight
 * itself implies — check-in the outbound leg's own arrival date, check-out
 * the inbound leg's own departure date (or +7 nights for a one-way).
 *
 * Side-trip second search (brief: "a side-trip second hotel search only
 * when the brief recorded a side trip AND a fixed commitment") is NOT
 * implemented here — researched and found unreachable with what this turn
 * actually has on hand. `TripBrief.sideTrip` (src/intake/brief.ts) is
 * computed by `assembleBrief` and then discarded: `writeBrief`
 * (src/agents/intake.ts) never writes it to the notebook, and it has no
 * field in `ResultsContent.query`/`assumptions` (src/results.ts) either.
 * `fixed_commitment` is answered by Jev (`buildIntakeQuestions`) but never
 * even read by `assembleBrief` — it reaches no `TripBrief` field at all.
 * Neither the notebook nor any `results` row this office ever writes
 * carries a side trip, so there is nothing here to key a second search on;
 * seeing this land is the backlog item for wiring `sideTrip` through to the
 * notebook first.
 */
async function handleChooseFlight(
  deps: IntakeDeps, ctx: AgentContext, sourceId: string,
): Promise<AgentStep> {
  const { sql } = deps
  const quote = await quoteForChoice(
    deps, ctx, 'flight', sourceId, 'That flight is no longer available. Pick another.',
  )
  if (quote.status === 'step') return quote.step
  const item = quote.item
  if (!isFlight(item)) {
    return { kind: 'park', message: 'That flight is no longer available. Pick another.', costMicros: 0n }
  }

  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  // Section 7's re-quote may already have cost a Jev re-rank; it rides the same `spent` total
  // the reviewer's call does, and is reported on `recordedMicros` exactly the same way.
  const spent = { micros: quote.cost }
  const round = await countPriorGateRuns(sql, ctx.turnId, 'choose-flight')
  let pathText: string
  try {
    pathText = await runProposalPath(deps, ctx, spent, {
      refs: [{ sourceId, quantity: 1, slot: 'flight' }], notebook, round, parentProposalId: null,
    })
  } catch {
    // I2: `spent.micros` already carries the reviewer's Opus call, debited by `reviewOffer`'s
    // own reserve/reconcile. Reporting it on `recordedMicros` is what gets it into the turn
    // total; letting the throw escape loses it.
    return { kind: 'fail', reason: 'fetch_failed', message: PATH_FAILED_MESSAGE, recordedMicros: spent.micros }
  }

  // `runProposalPath`'s own text is never read back here — a DB read of the
  // newest proposal FOR THIS TURN is what tells "saved" from "rejected"
  // (see `loadNewestProposalForTurn`'s own doc comment), the same thing
  // `propose_itinerary`'s caller (the driver) gets for free by having the
  // MODEL read that text instead.
  const saved = await loadNewestProposalForTurn(sql, ctx.turnId)
  if (!saved) {
    return {
      kind: 'park', message: rejectionMessage(pathText), costMicros: 0n,
      // Already debited by `reviewOffer`'s own reserve/reconcile inside
      // `runProposalPath` — reported, never re-spent. See that function's
      // own doc comment on `spent`.
      recordedMicros: spent.micros,
    }
  }

  await decideProposal(sql, {
    proposalId: saved.id, conversationId: ctx.conversationId, decision: 'accept', now: new Date(deps.now()),
  })

  // The chosen flight names an AIRPORT ("NRT"), and the place table is keyed on METROS ("TYO").
  // `stayWindowForFlight` (src/agents/hotels.ts) is what bridges the two; before the hotels pass
  // this read `CODE_MAP.get('NRT')`, got nothing, and sent the bare code to the hotel engine.
  // It lives in that module rather than here so `handleRefresh` can ask the identical question
  // of the identical flight — the polish pass's section 2.
  const window = stayWindowForFlight(item.detail)
  const destination = window?.place ?? null
  const checkIn = window?.checkIn ?? ''
  const checkOut = window?.checkOut ?? ''

  if (destination === null) {
    return {
      kind: 'park', message: UNKNOWN_DESTINATION_MESSAGE, costMicros: 0n,
      recordedMicros: spent.micros,
      attachments: [nextStepsAttachment('zero_hotels')],
    }
  }

  const latestResults = await readLatestResults(sql, ctx.conversationId, ctx.userId)
  const adults = notebook.partySize?.value.adults ?? latestResults?.query.adults ?? 1
  const currency = notebook.budget === null ? 'EUR' : notebook.budget.value.currency

  const params = hotelSearchFor({ place: destination, checkIn, checkOut, adults, currency })
  // The same arithmetic the adapter does for `HotelDetail.nights`, done once here for the
  // sentence — the reply must say the same number the cards do.
  const nights = nightsBetween(checkIn, checkOut)

  try {
    const budget = await assertSupplierBudget(sql, ctx.turnId, deps.limits.maxSupplierCallsPerTurn)
    if (!budget.ok) {
      return {
        kind: 'fail', reason: 'limit_reached',
        message: `The flight is accepted, but you have used all ${budget.max} supplier searches `
          + `for this turn (${budget.used} so far). Please ask again in a moment for hotels.`,
        recordedMicros: spent.micros,
      }
    }

    // begin -> run -> finish, same shape as src/agents/intake.ts's own
    // supplier-search block: persisting intent before the external effect is
    // what makes a kill-and-resume safe. No provider `tool_use` id exists
    // here either — this is not model-driven — so the call id is a fixed
    // literal; a `choose` action's turn searches hotels at most once.
    const callId = 'choose-hotels'
    const begun = await beginToolCall(sql, ctx.turnId, callId, 'explore_hotels')
    let items: SupplierItem[]
    if (begun.status === 'ambiguous') {
      throw new Error('choose: a previous hotel search for this turn did not finish')
    } else if (begun.status === 'replayed') {
      const sourceIds = (begun.result as { sourceIds: string[] }).sourceIds
      const rehydrated = await rehydrate(sql, ctx.conversationId, sourceIds)
      items = sourceIds.flatMap((id) => {
        const found = rehydrated.get(id)
        return found ? [found] : []
      })
    } else {
      // Section 10: the same stay search this traveller already ran, inside its own window,
      // answers this one — choosing a flight for a trip she is planning in two conversations is
      // exactly the case. The rows keep their original timestamps.
      const cached = await cachedSearch(sql, ctx.userId, params, new Date(deps.now()))
      logCache(cached !== null, params)
      // The distance from the city centre is this office's own arithmetic over the search it
      // just ran, not the supplier's — so it is stamped on before `recordResults` writes the
      // corpus row, and a replayed call gets it back from the corpus for free. A cached row
      // already carries it, and re-stamping it changes nothing.
      items = withDistanceFromCentre(cached ?? await deps.hotels.search(params), destination)
      await finishToolCall(sql, ctx.turnId, callId, { sourceIds: items.map((i) => i.sourceId) })
    }

    await recordResults(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
    })

    // Jev's own re-rank, the same seat and the same four levels the flight list is ordered by.
    // Without it the list is SearchApi's relevance order, which for a 16-night Tokyo window puts
    // six vacation rentals above the first hotel she would actually book.
    //
    // A re-rank failure is NOT a turn failure here: the flight is accepted and the hotels are
    // real, so the supplier's own order is shown rather than nothing. (Section 7's unverified
    // line is the UI half of this same decision.)
    let rerankCost = 0n
    let ordered = items
    // `null`, not `{}`: absent verdicts mean the list was never checked, and the pane says so in
    // as many words rather than implying every stay passed. See `ResultsContent.verdicts`.
    let verdicts: Record<string, { matches: string[]; issues: string[] }> | null = null
    if (items.length > 1) {
      try {
        const ranked = await rankItems(
          { jev: deps.jev },
          briefForHotelRank({ adults, checkIn, checkOut, place: destination }),
          items,
        )
        ordered = ranked.ordered
        verdicts = ranked.verdicts
        rerankCost = await recordJevCall(sql, {
          conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
          seat: 'rerank', request: ranked.request, response: ranked.response,
        })
      } catch {
        ordered = items
        verdicts = null
      }
    }

    // M1: a zero-item search used to reply "Here are hotels in Tokyo for 20 Nov to 6 Dec." with
    // a `results` attachment whose `sourceIds` was empty — `recordResults` short-circuits on an
    // empty list, so the row named a corpus that was never written, and it rendered as an empty
    // list with filter chips over it. No attachment and its own sentence instead; the flight is
    // still accepted, so this is a `park`, not a `fail`.
    if (items.length === 0) {
      return {
        kind: 'park',
        message: `I could not find hotels in ${destination.city} for those dates. `
          + 'Tell me a different area or dates.',
        costMicros: rerankCost,
        recordedMicros: spent.micros,
        // F2: no results row (M1 — there is no corpus to name), but still the two steps that can
        // turn an empty hotel search into a full one.
        attachments: [nextStepsAttachment('zero_hotels')],
      }
    }

    // Section 8c: the desk CONTINUES the conversation instead of filing a receipt for its own
    // search. "Here are hotels in Tokyo for 20 Nov to 6 Dec, 16 nights, two adults." says only
    // what the summary bar above the list already says, and leaves her with a blank composer in
    // front of eighteen cards. `hotelsFoundReply` says what is IN the list and asks the question
    // a travel agent would ask next; the window stays, because it is the one fact of the search
    // that nothing else in the reply repeats.
    const found = hotelsFoundReply(destination.city, ordered)
    return {
      kind: 'park',
      message: found === null
        ? `Nice choice. Here are hotels in ${destination.city} for `
          + `${dateLabel(checkIn)} to ${dateLabel(checkOut)}, ${nights} `
          + `${nights === 1 ? 'night' : 'nights'}, ${countWord(adults)} `
          + `${adults === 1 ? 'adult' : 'adults'}.`
        : `Nice choice. ${found} That is `
          + `${dateLabel(checkIn)} to ${dateLabel(checkOut)}, ${nights} `
          + `${nights === 1 ? 'night' : 'nights'}, ${countWord(adults)} `
          + `${adults === 1 ? 'adult' : 'adults'}.`,
      costMicros: rerankCost,
      recordedMicros: spent.micros,
      attachments: [
        {
          role: 'results',
          content: {
            kind: 'hotels',
            query: {
              place: destination.hotelName, outbound: checkIn, inbound: checkOut, adults,
              // What lets `handleRefresh` rebuild the SAME query (`hotels in Tokyo, Japan`) and
              // the same `gl` from the stored row, instead of re-deriving a different one.
              country: destination.country,
            },
            sourceIds: ordered.map((i) => i.sourceId),
            assumptions: [],
            ...(verdicts ? { verdicts } : {}),
          },
        },
        nextStepsAttachment('hotels'),
      ],
    }
  } catch {
    // The flight proposal is already durable and accepted by this point —
    // only the hotel search failed. No `recordSpend` here: `spent.micros`
    // was already debited by `reviewOffer`'s own reserve/reconcile above,
    // and this function makes no OTHER spend of its own to debit.
    return {
      kind: 'fail', reason: 'fetch_failed',
      message: 'The flight is accepted, but I could not reach the hotel search just now. '
        + 'Please try again in a moment.',
      recordedMicros: spent.micros,
    }
  }
}

/**
 * Choosing a hotel: the combined `[flight, stay]` proposal through the same
 * gates/reviewer path, left UNDECIDED. The flight half of the refs is
 * recovered from the newest ACCEPTED proposal for this conversation — the one
 * a prior `choose: 'flight'` turn just saved — never from anything the
 * traveller's message could name.
 *
 * The final review's C4: this used to `decideProposal(... 'accept')` here, and
 * that made the whole hand-off unreachable.
 * `web/components/PinnedSummary.tsx` renders "Get booking links" ONLY while
 * `decision === null`, and the links branch needs `links.length > 0`, which
 * only `hand_off_to_booking`/the cashier ever populates; `ResultsPaneLive`'s
 * `onGetLinks` early-returns on a non-null decision too, and `POST /decide`
 * would throw `decideProposal: ... already decided` anyway. So she saw a
 * summary with a total, no button and no links, and the cashier, the price
 * re-check and the tracked links were dead code for the entire plan-5 flow.
 *
 * Spec section 9 settles it ("Choose is acceptance; 'Get booking links' is the
 * hand-off") against plan Task 9 Step 2's wiring of the button to
 * `/decide { decision: 'accept' }`: the button IS the acceptance. Undecided
 * here means `/decide` accepts it inside `submitAction`'s `onFreshTurn`, the
 * `hand_off` action reaches the driver, and the cashier mints the links.
 *
 * The FLIGHTS-ONLY proposal stays accepted in `handleChooseFlight`:
 * `loadNewestAcceptedItinerary` is how this function recovers the flight half,
 * and it reads only accepted rows.
 */
async function handleChooseHotel(
  deps: IntakeDeps, ctx: AgentContext, sourceId: string,
): Promise<AgentStep> {
  const { sql } = deps
  const quote = await quoteForChoice(
    deps, ctx, 'hotel', sourceId, 'That hotel is no longer available. Pick another.',
  )
  if (quote.status === 'step') return quote.step

  const priorItinerary = await loadNewestAcceptedItinerary(sql, ctx.conversationId)
  const flightSourceId = priorItinerary?.items.find((i) => i.slot === 'flight')?.sourceId ?? null
  if (!flightSourceId) {
    return { kind: 'park', message: 'Choose a flight first, then a hotel.', costMicros: 0n }
  }

  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  const spent = { micros: quote.cost }
  const round = await countPriorGateRuns(sql, ctx.turnId, 'choose-hotel')
  let pathText: string
  try {
    pathText = await runProposalPath(deps, ctx, spent, {
      refs: [
        { sourceId: flightSourceId, quantity: 1, slot: 'flight' },
        { sourceId, quantity: 1, slot: 'stay' },
      ],
      notebook, round, parentProposalId: null,
    })
  } catch {
    // I2, same as the flight arm above.
    return { kind: 'fail', reason: 'fetch_failed', message: PATH_FAILED_MESSAGE, recordedMicros: spent.micros }
  }

  const saved = await loadNewestProposalForTurn(sql, ctx.turnId)
  if (!saved) {
    return {
      kind: 'park', message: rejectionMessage(pathText), costMicros: 0n,
      recordedMicros: spent.micros,
    }
  }

  return {
    kind: 'park',
    message: 'Trip summary ready. Use "Get booking links" when you want to book.',
    costMicros: 0n,
    recordedMicros: spent.micros,
    // F2: the summary's own two steps. Both are answered by the router itself rather than by Jev
    // — `get_links` names a button and `change_flight` re-shows a stored row — see
    // `ROUTER_HANDLED_NEXT` (src/agents/nextSteps.ts).
    attachments: [nextStepsAttachment('summary')],
  }
}

export async function handleChoose(
  deps: IntakeDeps, ctx: AgentContext, action: ChooseAction,
): Promise<AgentStep> {
  return action.kind === 'flight'
    ? handleChooseFlight(deps, ctx, action.sourceId)
    : handleChooseHotel(deps, ctx, action.sourceId)
}
