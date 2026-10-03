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
import { loadNotebook } from '../repo/notebook.js'
import { decideProposal, loadNewestAcceptedItinerary, loadNewestProposalForTurn } from '../repo/proposals.js'
import { rehydrate, recordResults } from '../repo/toolResults.js'
import { readLatestResults } from '../repo/messages.js'
import { countPriorGateRuns, beginToolCall, finishToolCall } from '../repo/toolCalls.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { CODE_MAP } from '../intake/places.js'
import { addDays } from '../intake/dates.js'
import { isFlight, isHotel, type HotelSearch, type SupplierItem } from '../supplier/types.js'

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

/** 'D Mon' — e.g. '2026-11-20' -> '20 Nov'. Same shape as src/agents/intake.ts's own `dateLabel`
 * (not exported there, so duplicated here rather than reached across a module boundary that
 * exists for an unrelated reason). */
function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/** The place table's own city name for a code — what the message she reads says, and what
 * `ResultsContent.query.place` carries for display. Never her span, never a supplier's name. */
function cityLabel(code: string): string {
  return CODE_MAP.get(code)?.city ?? code
}

/** Ledger ruling 3: `Place.hotelName` (defaulting to `city`) is what a hotel search sends as its
 * `query` — Kyoto's own entry is the one case where the two differ. */
function hotelQueryName(code: string): string {
  const p = CODE_MAP.get(code)
  return p?.hotelName ?? p?.city ?? code
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
  const stored = await rehydrate(sql, ctx.conversationId, [sourceId])
  const item = stored.get(sourceId)
  if (!item || !isFlight(item)) {
    return { kind: 'park', message: 'That flight is no longer available. Pick another.', costMicros: 0n }
  }

  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  const spent = { micros: 0n }
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

  const destinationCode = item.detail.outbound.to
  const checkIn = item.detail.outbound.arrivalLocal.slice(0, 10)
  const checkOut = item.detail.inbound
    ? item.detail.inbound.departureLocal.slice(0, 10)
    : addDays(checkIn, 7)

  const latestResults = await readLatestResults(sql, ctx.conversationId, ctx.userId)
  const adults = notebook.partySize?.value.adults ?? latestResults?.query.adults ?? 1
  const currency = notebook.budget === null ? 'EUR' : notebook.budget.value.currency

  const params: HotelSearch = {
    kind: 'hotel', query: hotelQueryName(destinationCode), checkIn, checkOut, adults, currency,
  }

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
      items = await deps.hotels.search(params)
      await finishToolCall(sql, ctx.turnId, callId, { sourceIds: items.map((i) => i.sourceId) })
    }

    await recordResults(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
    })

    // M1: a zero-item search used to reply "Here are hotels in Tokyo for 20 Nov to 6 Dec." with
    // a `results` attachment whose `sourceIds` was empty — `recordResults` short-circuits on an
    // empty list, so the row named a corpus that was never written, and it rendered as an empty
    // list with filter chips over it. No attachment and its own sentence instead; the flight is
    // still accepted, so this is a `park`, not a `fail`.
    if (items.length === 0) {
      return {
        kind: 'park',
        message: `I could not find hotels in ${cityLabel(destinationCode)} for those dates. `
          + 'Tell me a different area or dates.',
        costMicros: 0n,
        recordedMicros: spent.micros,
      }
    }

    return {
      kind: 'park',
      message: `Flight noted. Here are hotels in ${cityLabel(destinationCode)} for `
        + `${dateLabel(checkIn)} to ${dateLabel(checkOut)}.`,
      costMicros: 0n,
      recordedMicros: spent.micros,
      attachments: [{
        role: 'results',
        content: {
          kind: 'hotels',
          query: { place: cityLabel(destinationCode), outbound: checkIn, inbound: checkOut, adults },
          sourceIds: items.map((i) => i.sourceId),
          assumptions: [],
        },
      }],
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
  const stored = await rehydrate(sql, ctx.conversationId, [sourceId])
  const item = stored.get(sourceId)
  if (!item || !isHotel(item)) {
    return { kind: 'park', message: 'That hotel is no longer available. Pick another.', costMicros: 0n }
  }

  const priorItinerary = await loadNewestAcceptedItinerary(sql, ctx.conversationId)
  const flightSourceId = priorItinerary?.items.find((i) => i.slot === 'flight')?.sourceId ?? null
  if (!flightSourceId) {
    return { kind: 'park', message: 'Choose a flight first, then a hotel.', costMicros: 0n }
  }

  const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
  const spent = { micros: 0n }
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
  }
}

export async function handleChoose(
  deps: IntakeDeps, ctx: AgentContext, action: ChooseAction,
): Promise<AgentStep> {
  return action.kind === 'flight'
    ? handleChooseFlight(deps, ctx, action.sourceId)
    : handleChooseHotel(deps, ctx, action.sourceId)
}
