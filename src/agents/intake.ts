/**
 * The intake agent: her first message, straight through to a results row. Replaces the Haiku
 * front desk for the first turn (src/agents/route.ts) — one Jev call turns her message into a
 * `TripBrief` or a choice card (src/intake/brief.ts), a complete brief goes straight to the
 * flight supplier, and a second Jev call re-ranks whatever comes back before it reaches her
 * (src/intake/rank.ts).
 *
 * Same trust-boundary instinct as the driver (src/agents/driver.ts): `replyText` below is built
 * only from the brief's own enum/ISO values and the place table's names, never from her text.
 */
import type postgres from 'postgres'
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import type { TurnState } from '../engine.js'
import type { DriverDeps } from './driver.js'
import { runIntake, type TripBrief, type Cabin, type Assumption } from '../intake/brief.js'
import { rankItems } from '../intake/rank.js'
import type { JevDeps } from '../jev/client.js'
import { recordJevCall } from '../jev/record.js'
import { recordResults, rehydrate } from '../repo/toolResults.js'
import { readLastOrigin, setDesk } from '../repo/conversations.js'
import { recordSpend } from '../repo/spend.js'
import { applyRequirementsPatch } from '../repo/notebook.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { beginToolCall, finishToolCall } from '../repo/toolCalls.js'
import { CODE_MAP } from '../intake/places.js'
import { addDays } from '../intake/dates.js'
import type { FlightSearch, SupplierItem } from '../supplier/types.js'

export type IntakeDeps = DriverDeps & { jev: JevDeps }

/**
 * Fix round 1: the ONE thing the catch in `runIntakeTurn` below needs to tell apart — a supplier
 * error (`reason: 'provider_down'`, the traveller can just retry) from a Jev/rank or bookkeeping
 * error (`reason: 'fetch_failed'`) — without duplicating a try/catch around every single
 * statement. Thrown only by the supplier-search branch; every other throw inside the same block
 * falls through to the default `fetch_failed` branch.
 */
class IntakeSupplierError extends Error {}

/**
 * Kiwi's own cabin vocabulary (src/supplier/kiwi.ts sends `cabinClass` straight through to the
 * supplier as a request parameter) — a translation local to this call, never written back to the
 * notebook or the results row, both of which keep the brief's own `Cabin` enum.
 */
const KIWI_CABIN: Record<Cabin, string> = {
  economy: 'Economy', premium_economy: 'PremiumEconomy', business: 'Business', first: 'First',
}
function kiwiCabin(cabin: Cabin): string {
  return KIWI_CABIN[cabin]
}

/** The newest user message's text — same contract as the driver's own `lastUserText`. */
function lastUserText(state: TurnState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!
    if (m.role !== 'user') continue
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (text.length > 0) return text
  }
  return ''
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'D Mon' — e.g. '2026-11-19' -> '19 Nov'. ISO in, fixed English out; never her words. */
function dateLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${MONTH_ABBR[m - 1]}`
}

/** The place table's own city name for a code (ledger ruling: never her span). */
function placeLabel(code: string): string {
  return CODE_MAP.get(code)?.city ?? code
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

function cabinLabel(c: Cabin): string {
  return c === 'premium_economy' ? 'premium economy' : c.replace('_', ' ')
}

/**
 * One fixed phrase per `Assumption.field` (src/intake/brief.ts's `assembleBrief` is the only
 * writer of this list) — `null` for a field this reply never mentions. The 'outbound' phrase is
 * the one `assembleBrief` writes exactly once, when an arrival deadline moves the departure a day
 * earlier: `a.value` is the ADJUSTED (departure) date, so the day she arrives is one later.
 */
function assumptionPhrase(a: Assumption): string | null {
  switch (a.field) {
    case 'year': return `the year ${a.value.slice(0, 4)}`
    case 'outbound': return `leaving a day early so you arrive on the ${ordinal(Number(addDays(a.value, 1).slice(8, 10)))}`
    case 'origin': return `flying from ${placeLabel(a.value)}`
    case 'inbound': return `a week there if you did not say when you are back`
    case 'adults': return 'just the one of you'
    case 'cabin_long': return 'economy for the long flights'
    case 'cabin_short': return 'economy for the short flights'
    default: return null
  }
}

/**
 * Fixed English, built only from the brief's own enum/ISO values and the place table's names —
 * never from her text, same trust-boundary instinct as `src/results.ts`'s renderers. `resultCount`
 * decides only the opening clause; everything else is identical whether the search found
 * anything or not.
 */
export function replyText(b: TripBrief, resultCount: number): string {
  const adults = `${b.adults} adult${b.adults === 1 ? '' : 's'}`
  const dates = b.inbound ? `${dateLabel(b.outbound)} to ${dateLabel(b.inbound)}` : `${dateLabel(b.outbound)}, one way`
  const trip = `${adults}, ${placeLabel(b.origin)} to ${placeLabel(b.destination)}, ${dates}, ${cabinLabel(b.cabinLong)}`
  const head = resultCount === 0 ? `I could not find flights for ${trip}.` : `Here are flights for ${trip}.`
  const phrases = [...new Set(b.assumptions.map(assumptionPhrase).filter((s): s is string => s !== null))]
  const assumed = phrases.length > 0 ? ` I assumed: ${phrases.join('; ')}.` : ''
  return `${head}${assumed} Change anything with the chips above the list or just tell me.`
}

/**
 * Transcribes the brief into the notebook, in the notebook's own key vocabulary
 * (src/notebook.ts) — only the keys that exist there: `originCity`, `destination`,
 * `departureDate`, `returnDate`, `partySize`. The notebook carries no `cabin` field at all
 * (`PatchSchema` is `.strict()`, so sending one would reject the WHOLE patch) — cabin stays in
 * the brief and the results row only; see the task report for this as a backlog item. `source:
 * 'user'` because intake runs on step 0 of a fresh turn, which `loop()` (src/worker.ts) hydrates
 * from `messages` as role+text only — her words, untainted by anything else (same reasoning as
 * `provenanceFor` in src/agents/driver.ts).
 */
async function writeBrief(sql: postgres.Sql, ctx: AgentContext, b: TripBrief): Promise<void> {
  const patch: Record<string, unknown> = {
    originCity: b.origin,
    destination: b.destination,
    departureDate: b.outbound,
    partySize: { adults: b.adults, children: 0, infants: 0 },
  }
  if (b.inbound) patch.returnDate = b.inbound
  await applyRequirementsPatch(sql, { conversationId: ctx.conversationId, userId: ctx.userId, patch, source: 'user' })
}

/**
 * One run of the intake agent, factored out of `makeIntake` so Task 6's router can call it a
 * second time in the same turn — ledger ruling 2: a `choice` action re-runs intake on the
 * original message with `overrides` forcing the questionId she just answered to the optionId she
 * clicked, at confidence 1. `opts.text` is the message to run on (her first message for
 * `makeIntake`'s own call, the ORIGINAL message — the newest `user` row before the `choice`
 * action — for the router's re-run); `opts.overrides` is `runIntake`'s own parameter, threaded
 * straight through. `opts.lastOrigin`, when given, REPLACES the `readLastOrigin` lookup below
 * rather than falling back to it — the router's `new_search` path (src/agents/router.ts) prefers
 * the notebook's own `originCity` over her past searches, since a follow-up in an existing
 * conversation has a nearer answer than "the last time she searched anything".
 */
export async function runIntakeTurn(
  deps: IntakeDeps, ctx: AgentContext,
  opts: {
    text: string
    overrides?: Partial<Record<'origin' | 'destination' | 'outbound', string>>
    lastOrigin?: string | null
  },
): Promise<AgentStep> {
  const { sql } = deps
  const text = opts.text
  const today = new Date(deps.now())
  const lastOrigin = opts.lastOrigin !== undefined ? opts.lastOrigin : await readLastOrigin(sql, ctx.userId)
  const { outcome, request, response } = await runIntake({ jev: deps.jev }, text, today, lastOrigin, opts.overrides)

  let cost = await recordJevCall(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'intake', request, response,
  })

  if (outcome.kind === 'choices') {
    // Ledger ruling: desk flips to 'planning' at the end of EVERY run, brief or choices — a
    // choice card is not a reason to keep seeing the front door again next turn. Task 6's router
    // re-runs intake specifically for a choice-click action and for a `new_search` message; both
    // calls land here too, so this still only ever flips desk to the value it is already at.
    //
    // Fix round 1: called as the LAST action on this path (it was unconditional, right after the
    // intake Jev call, before) — nothing below it can throw, so a conversation can no longer be
    // left at 'planning' with the choice card never actually sent.
    await setDesk(sql, ctx.conversationId, ctx.userId, 'planning')
    return {
      kind: 'park', message: outcome.question, costMicros: cost,
      attachments: [{
        role: 'choices',
        content: { questionId: outcome.questionId, question: outcome.question, options: outcome.options },
      }],
    }
  }

  const b = outcome.brief
  const params: FlightSearch = {
    kind: 'flight', from: b.origin, to: b.destination,
    departureDate: b.outbound, returnDate: b.inbound, flexDays: 0,
    adults: b.adults, children: 0, infants: 0,
    cabinClass: kiwiCabin(b.cabinLong),
    // Backlog: currency should follow the origin, not a fixed EUR — flagged in the task
    // report rather than guessed at here.
    currency: 'EUR',
    maxStops: b.maxStops, allowSelfTransfer: false,
  }

  /**
   * Fix round 1: everything from here down used to run with `desk` ALREADY flipped to
   * 'planning' and no guard at all — a throw anywhere in this stretch (the search, the rerank
   * call, a notebook write) stranded the conversation at 'planning' with no notebook and no
   * results row, while the intake Jev call already sitting in `model_calls` never reached
   * `recordSpend`. Now: `desk` stays 'front' (so a retry of the same message sees the same front
   * door) until EVERYTHING below has succeeded, and any throw is caught once, debits the Jev
   * cost already recorded, and fails the turn with words she can act on.
   */
  try {
    // Spec §1.4: a direct supplier call is still a supplier call, and must count against the
    // same per-turn budget `explore_flights` does — read as `explore_flights` for exactly that
    // reason, mirroring the driver's own door rather than inventing a parallel counter.
    const budget = await assertSupplierBudget(sql, ctx.turnId, deps.limits.maxSupplierCallsPerTurn)
    if (!budget.ok) {
      await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: cost })
      return {
        kind: 'fail', reason: 'limit_reached',
        message: `You have used all ${budget.max} supplier searches for this turn `
          + `(${budget.used} so far). Please try again in a moment, or start a new conversation.`,
        recordedMicros: cost,
      }
    }

    // begin -> run -> finish, same as the driver's door around `explore_flights`
    // (src/agents/driver.ts's `execute`, via `loop()`'s generic 'tool' handling) — persisting
    // intent before the external effect is what makes a kill-and-resume safe. There is no
    // provider `tool_use` id to key this on (nothing here is model-driven), so the call id is a
    // fixed literal: intake searches flights at most once per turn, and `(turn_id, call_id)` is
    // the primary key, so uniqueness only has to hold WITHIN this turn.
    const callId = 'intake-flights'
    const begun = await beginToolCall(sql, ctx.turnId, callId, 'explore_flights')
    let items: SupplierItem[]
    if (begun.status === 'ambiguous') {
      // The previous attempt died mid-flight; we cannot tell whether the supplier was actually
      // called. Same posture as `src/worker.ts`'s own 'ambiguous' handling: do not guess either
      // way, surface it as a supplier-side failure she can retry.
      throw new IntakeSupplierError('intake: a previous attempt at this search did not finish')
    } else if (begun.status === 'replayed') {
      // Rebuilt from the durable corpus (`tool_results`, written below on a FRESH run), not from
      // the tool_calls row itself — that row stores only the ids, never the full item (whose
      // price is a bigint, which does not survive a plain JSON round trip).
      const sourceIds = (begun.result as { sourceIds: string[] }).sourceIds
      const rehydrated = await rehydrate(sql, ctx.conversationId, sourceIds)
      items = sourceIds.flatMap((id) => {
        const item = rehydrated.get(id)
        return item ? [item] : []
      })
    } else {
      try {
        items = await deps.flights.search(params)
      } catch (err) {
        throw new IntakeSupplierError(err instanceof Error ? err.message : String(err))
      }
      // Marks the EXTERNAL effect done — a resumed turn must never call Kiwi again for this
      // search — independent of whether anything below (the rerank call, the notebook write)
      // later fails; that is a durability question about OUR OWN corpus, not about the supplier
      // call having happened.
      await finishToolCall(sql, ctx.turnId, callId, { sourceIds: items.map((i) => i.sourceId) })
    }

    const ranked = items.length > 1
      ? await rankItems({ jev: deps.jev }, b, items)
      : { ordered: items, request: null, response: null }

    if (ranked.response) {
      cost += await recordJevCall(sql, {
        conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
        seat: 'rerank', request: ranked.request!, response: ranked.response,
      })
    }

    // The three things that must land together, only once both the search AND the re-rank have
    // actually succeeded: the corpus row, the notebook patch, and the desk flip. Any earlier
    // throw leaves all three untouched (caught below).
    await recordResults(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
    })
    await writeBrief(sql, ctx, b)
    await setDesk(sql, ctx.conversationId, ctx.userId, 'planning')

    return {
      kind: 'park', message: replyText(b, ranked.ordered.length), costMicros: cost,
      attachments: [{
        role: 'results',
        content: {
          kind: 'flights',
          query: {
            from: b.origin, to: b.destination, outbound: b.outbound, inbound: b.inbound,
            adults: b.adults, cabin: b.cabinLong,
          },
          sourceIds: ranked.ordered.slice(0, 10).map((i) => i.sourceId),
          assumptions: b.assumptions,
        },
      }],
    }
  } catch (err) {
    // No `costMicros` on the `fail` arm (src/worker.ts): a failing step's spend must already be
    // debited by the time `loop()` sees it. The Jev call(s) above have not been —
    // `recordJevCall` only writes the ledger row, it never touches
    // `conversations.spend_usd_micros` — so whatever is in `cost` so far is debited here, by
    // hand, exactly once, the same way the driver's reserve/reconcile debits its own call before
    // a tool ever runs.
    await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: cost })
    if (err instanceof IntakeSupplierError) {
      return {
        kind: 'fail', reason: 'provider_down',
        message: 'I could not reach the flight search just now. Please try again in a moment.',
        recordedMicros: cost,
      }
    }
    // Everything else — the rerank call, a notebook write, the desk flip itself — is not a
    // supplier error; `fetch_failed` is the closest named reason (src/engine.ts's `FailReason`)
    // for "something in putting the results together did not work."
    return {
      kind: 'fail', reason: 'fetch_failed',
      message: 'Something went wrong while putting your results together. Please try again.',
      recordedMicros: cost,
    }
  }
}

/**
 * The planning desk's front door, for a fresh turn at `desk = 'front'`: one Jev call turns her
 * first message into a brief or a choice card. `runIntakeTurn` above is the one that actually
 * does it — this is a thin wrapper that supplies HER message (the newest `user` row) and no
 * overrides, exactly `makeIntake`'s old behaviour before Task 6 split the two apart.
 */
export function makeIntake(deps: IntakeDeps): Agent {
  return (ctx: AgentContext): Promise<AgentStep> => runIntakeTurn(deps, ctx, { text: lastUserText(ctx.state) })
}
