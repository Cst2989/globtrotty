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
import { recordResults } from '../repo/toolResults.js'
import { readLastOrigin, setDesk } from '../repo/conversations.js'
import { recordSpend } from '../repo/spend.js'
import { applyRequirementsPatch } from '../repo/notebook.js'
import { CODE_MAP } from '../intake/places.js'
import { addDays } from '../intake/dates.js'
import type { FlightSearch } from '../supplier/types.js'

export type IntakeDeps = DriverDeps & { jev: JevDeps }

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
 * The planning desk's new front door: one Jev call turns her first message into a brief or a
 * choice card; a complete brief goes straight to the flight supplier and, if more than one item
 * came back, through one re-rank call before it is shown. Every run — brief or choices — ends
 * with `conversations.desk = 'planning'` (ledger ruling): the front desk's job of recognising a
 * trip request is gone, replaced by intake actually building one.
 */
export function makeIntake(deps: IntakeDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql } = deps
    const text = lastUserText(ctx.state)
    const today = new Date(deps.now())
    const lastOrigin = await readLastOrigin(sql, ctx.userId)
    const { outcome, request, response } = await runIntake({ jev: deps.jev }, text, today, lastOrigin)

    let cost = await recordJevCall(sql, {
      conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
      seat: 'intake', request, response,
    })

    // Ledger ruling: desk flips to 'planning' at the end of EVERY run, brief or choices — a
    // choice card is not a reason to keep seeing the front door again next turn. Task 6's router
    // is what re-runs intake specifically for a choice-click action; this task only has to make
    // that re-run possible, not wire it.
    await setDesk(sql, ctx.conversationId, ctx.userId, 'planning')

    if (outcome.kind === 'choices') {
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

    let items
    try {
      items = await deps.flights.search(params)
    } catch {
      // No `costMicros` on the `fail` arm (src/worker.ts): a failing step's spend must already be
      // debited by the time `loop()` sees it. The Jev call above has not been — `recordJevCall`
      // only writes the ledger row, it never touches `conversations.spend_usd_micros` — so it is
      // debited here, by hand, exactly once, the same way the driver's reserve/reconcile debits
      // its own call before a tool ever runs.
      await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: cost })
      return {
        kind: 'fail', reason: 'provider_down',
        message: 'I could not reach the flight search just now. Please try again in a moment.',
        recordedMicros: cost,
      }
    }

    await recordResults(sql, {
      conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
    })

    const ranked = items.length > 1
      ? await rankItems({ jev: deps.jev }, b, items)
      : { ordered: items, request: null, response: null }

    if (ranked.response) {
      cost += await recordJevCall(sql, {
        conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
        seat: 'rerank', request: ranked.request!, response: ranked.response,
      })
    }

    await writeBrief(sql, ctx, b)

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
  }
}
