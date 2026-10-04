/**
 * The Jev intent router: plan 5 Task 6's replacement for the Haiku front desk on every message
 * after the first. `desk === 'planning'` now reaches `makeRouter` (src/agents/route.ts), not the
 * driver directly — a typed message is first classified by one Jev call (`routeMessage` below)
 * into `filter` (apply over the stored results, no model, no search), `new_search` (re-run
 * intake), `question`/`chat` (the driver) or `faq` (a fixed answer, no model at all). An `action`
 * row (a card press) skips `routeMessage` entirely and dispatches on the action itself — see
 * `makeRouter`.
 */
import type postgres from 'postgres'
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import type { TurnState } from '../engine.js'
import {
  askJev, choiceQ, noulQ, type JevAnswer, type JevDeps, type JevQuestion, type JevRequest, type JevResponse,
} from '../jev/client.js'
import { recordJevCall } from '../jev/record.js'
import {
  readNewestMessage, readLatestResults, readLatestUnfilteredResults, readLatestChoices,
  readNewestUserTextBefore,
} from '../repo/messages.js'
import { rehydrate } from '../repo/toolResults.js'
import { readLastOrigin } from '../repo/conversations.js'
import { loadNotebook } from '../repo/notebook.js'
import { recordSpend } from '../repo/spend.js'
import { parseAction } from '../actions.js'
import { applyFilter, describeFilter } from '../intake/filter.js'
import { resolveConnectionsAvoidance } from '../intake/connectionsAlias.js'
import { airlineName } from '../intake/airlines.js'
import { airportCity } from '../intake/airports.js'
import { filterReply, conversationStage, nextStepsForStage, NO_FILTER_MESSAGE } from './stage.js'
import { formatMoney } from '../money.js'
import type { Filter, ResultsContent } from '../results.js'
import { isFlight, type StoredItem } from '../supplier/types.js'
import { runIntakeTurn, type IntakeDeps } from './intake.js'
import { nextStepsAttachment, NEXT_QUESTION_ID } from './nextSteps.js'
import { makeDriver } from './driver.js'
import { handleChoose } from './choose.js'
import { handleRefresh } from './refresh.js'
import { faqAnswer } from './frontDesk.js'

export type RouteIntent = 'filter' | 'new_search' | 'question' | 'chat' | 'faq'

const CONFIDENCE_GATE = 0.6
const NOUL_GATE = 0.6

/** Same shape as the Jev call's own `state`; `lastQuery` is the latest `results` row's `query`,
 * or `null` when she has none yet. */
export type RouteState = { message: string; hasResults: boolean; lastQuery: ResultsContent['query'] | null }

/**
 * The router's one Jev call, verbatim per the brief: `intent` always answers one of the five
 * (none of its criteria is a sentinel, unlike intake's own questions), `nonstop`/`cheaper` are
 * Noul yes/no, `departure` is a choice with its own `none` sentinel.
 */
function buildRouterQuestions(): Record<string, JevQuestion> {
  return {
    intent: choiceQ('What does this message do?', {
      filter: 'Narrows or re-sorts the flights or hotels already shown (direct only, cheaper, morning, a specific airline)',
      new_search: 'Changes the trip itself: other dates, another city, more people, a different cabin, or asks to search again',
      question: 'Asks for advice or information that needs a written answer',
      chat: 'Small talk, thanks, or a reply to a question the desk asked',
      faq: 'A question about the agency itself: payment, cancellations, visas, how prices are checked',
    }),
    nonstop: noulQ('She wants direct flights only'),
    // Unrecorded deviation 5: `FilterChips` offers "Up to 1 stop" and both `applyFilter` and
    // `applyFilterLite` implement `maxStops`, but no typed message could ever set it — spec
    // section 2.2's typed "up to 1 stop" silently resolved to plain `nonstop` or to nothing at
    // all. Kept as its own Noul rather than folded into `nonstop`'s criteria because the two
    // say different things and she can say either; `nonstop` wins when both fire.
    one_stop_ok: noulQ('She accepts at most one stop (a single connection is fine, two is not)'),
    departure: choiceQ('A departure time of day she asks for', { morning: null, afternoon: null, evening: null, none: 'None' }),
    cheaper: noulQ('She asks for cheaper options or a price cap'),
    // The bug this question exists for: "I don't want to stop in China or the Middle East"
    // used to classify as `filter` and change nothing, because nothing above asks about WHERE
    // she connects, only whether/how many times. Code, not Jev, resolves which country or
    // region she means (`resolveConnectionsAvoidance`) — Jev cannot extract free values (the
    // same division of labour `extractPriceMinor` documents), so this only tells the router
    // THAT she named one.
    avoid_connections: noulQ('She wants to avoid connecting through a specific country or region'),
  }
}

function choiceOf(answers: Record<string, JevAnswer>, key: string): { choice: string; confidence: number } | null {
  const a = answers[key]
  return a && a.type === 'choice' ? a : null
}

function noulOf(answers: Record<string, JevAnswer>, key: string): number {
  const a = answers[key]
  return a && a.type === 'noul' ? a.noul : 0
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Code-side, not Jev: carrier CODES are matched as whole words against the message, case-
 * insensitively, against only the carriers actually present in her latest results row — the
 * resolution in the ledger ("airline names are matched code-side against carriers present in the
 * latest results row's items"). Jev is never asked about an airline at all; this runs
 * unconditionally whenever there is a results row to match against, because it costs nothing
 * extra — no Jev question, no extra call.
 */
function matchAirlines(text: string, carriers: string[]): string[] {
  const matched = new Set<string>()
  for (const c of carriers) {
    if (c.length === 0) continue
    if (new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(text)) matched.add(c)
  }
  return [...matched]
}

/**
 * A spelled price cap or "cheaper than X" phrase, converted to minor units (×100 — every
 * currency this repo prices in today has two minor-unit digits). Jev cannot extract free values
 * (parent spec §0): the `cheaper` Noul question only tells the router THAT she named a cap; code
 * finds the number itself, the same division of labour as `src/intake/candidates.ts` finding
 * place/date spans for Jev to choose among. `null` when the `cheaper` signal fired but no number
 * is actually in the text — a plain "show me cheaper ones" with nothing to anchor to.
 */
function extractPriceMinor(text: string): bigint | null {
  const m = /(?:under|below|less\s+than|no\s+more\s+than|up\s+to|max(?:imum)?|budget(?:\s+of)?|cap(?:ped)?\s+at)\s*[€$£]?\s*(\d[\d.,]*)/i.exec(text)
  if (!m) return null
  const n = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return BigInt(Math.round(n * 100))
}

/**
 * "direct"/"nonstop" always mean `nonstop`; a BARE "no connections" does too, but only when
 * nothing after it names a place — "no connections in China" is the connections filter below,
 * not this one, and the negative lookahead is what keeps the two apart.
 */
const MAPS_TO_NONSTOP = /\b(?:direct|non-?stop)\b|\bno\s+connections?\b(?!\s*(?:in|through|via|near|to|at)\b)/i

/**
 * "Show me all flights" / "Show all flights again" (the `show_all` chip's own label, F2's own
 * "widen it back out" step) — a deliberate CLEAR, not a narrowing attempt, so the `Filter` it
 * resolves to being empty is the right answer, not a failure to understand. The router's own
 * empty-`Filter` honesty check (below, in `routeTyped`) carves this phrasing out for exactly
 * that reason: an empty `Filter` otherwise means "nothing in `routeMessage` recognised this".
 */
const WIDENS_FILTER = /\bshow\s+(?:me\s+)?all\b|\ball\s+(?:flights|hotels|results)\b|\bclear\b.*\bfilters?\b|\bremove\b.*\bfilters?\b/i

/**
 * What `filterReply` calls the cheapest surviving item: the supplier's own masked `name`
 * ordinarily, but — once a connections filter is active — the airline and the city it
 * connects through instead, because that is the one thing a traveller who just asked "not
 * through China or the Middle East" actually wants to hear confirmed, and a hotel-brand-shaped
 * `name` string says nothing about it. Reads the FIRST leg's first carrier and every leg's own
 * via airports, same tables `web/data.ts` already resolves client-side (`airlineName`,
 * `airportCity`) so the two never name a stop two different ways.
 */
function describeCheapestForReply(item: StoredItem, hasConnectionsFilter: boolean): string {
  if (!hasConnectionsFilter || !isFlight(item)) return item.name
  const legs = item.detail.inbound ? [item.detail.outbound, item.detail.inbound] : [item.detail.outbound]
  const carrier = legs.flatMap((leg) => leg.carriers)[0]
  const airline = carrier ? (airlineName(carrier) ?? carrier) : item.name
  const viaCities = [...new Set(legs.flatMap((leg) => leg.route.slice(1, -1)))].map((code) => airportCity(code) ?? code)
  return viaCities.length > 0 ? `${airline} via ${viaCities.join(' and ')}` : airline
}

/**
 * One Jev call, classifying her message and (for `filter`) building the `Filter` to apply. Pure
 * with respect to the database — the caller is the one who records the call (seat `router`) and
 * who knows what to do with the result; this function only talks to Jev. `carriers` is the set of
 * carrier codes present in her latest results row's items, for `matchAirlines`; `lastQuery` is
 * that row's own `query`, for the `state` Jev sees.
 */
export async function routeMessage(
  deps: { jev: JevDeps },
  text: string,
  hasResults: boolean,
  context: { lastQuery?: ResultsContent['query'] | null; carriers?: string[] } = {},
): Promise<{ intent: RouteIntent; filter?: Filter; request: JevRequest; response: JevResponse }> {
  const state: RouteState = { message: text, hasResults, lastQuery: context.lastQuery ?? null }
  const request: JevRequest = { state, questions: buildRouterQuestions() }
  const response = await askJev(deps.jev, request)
  const answers = response.answers

  const intentAnswer = choiceOf(answers, 'intent')
  // Every `intent` criterion is a real intent, with no `unstated`/`none` sentinel to fall through
  // on, so a confident choice is trusted outright; the 'chat' fallback below only guards a
  // malformed/missing answer (an empty `answers` object), never a genuine low-confidence pick.
  const intent = (intentAnswer?.choice ?? 'chat') as RouteIntent

  if (intent !== 'filter') return { intent, request, response }

  const filter: Filter = {}
  if (noulOf(answers, 'nonstop') > NOUL_GATE) filter.nonstop = true
  // Only when she did NOT ask for direct only: `nonstop` is the stricter of the two, and
  // `describeFilter` would otherwise print both.
  else if (noulOf(answers, 'one_stop_ok') > NOUL_GATE) filter.maxStops = 1

  // Code-side backstop, not a Jev question: "direct" and a bare "no connections" (one with
  // nothing after it naming a place — that reads as `avoid_connections` below instead) mean
  // the same thing `nonstop` already does, and a terse message is exactly the shape the Noul
  // gate above is most likely to miss. Wins over `one_stop_ok` when both somehow fired, since
  // the literal word is stronger evidence than a Noul guess.
  if (!filter.nonstop && MAPS_TO_NONSTOP.test(text)) {
    filter.nonstop = true
    delete filter.maxStops
  }

  const departureAnswer = choiceOf(answers, 'departure')
  if (departureAnswer && departureAnswer.confidence >= CONFIDENCE_GATE && departureAnswer.choice !== 'none') {
    filter.departure = departureAnswer.choice as 'morning' | 'afternoon' | 'evening'
  }

  const matchedAirlines = matchAirlines(text, context.carriers ?? [])
  if (matchedAirlines.length > 0) filter.airlines = matchedAirlines

  if (noulOf(answers, 'cheaper') > NOUL_GATE) {
    const maxPrice = extractPriceMinor(text)
    if (maxPrice !== null) filter.maxPriceMinor = maxPrice.toString()
  }

  // The bug this office was filed for: resolved only when the Noul signal above fired, exactly
  // the same gating `cheaper`'s own price extraction already uses — Jev says THAT she named a
  // place to avoid connecting through, code says WHICH one, off the fixed alias table
  // (`resolveConnectionsAvoidance`, src/intake/connectionsAlias.ts). Never from the free text
  // directly.
  if (noulOf(answers, 'avoid_connections') > NOUL_GATE) {
    const { countries, regions } = resolveConnectionsAvoidance(text)
    if (countries.length > 0) filter.avoidCountries = countries.slice(0, 10)
    if (regions.length > 0) filter.avoidRegions = regions.slice(0, 10)
  }

  return { intent: 'filter', filter, request, response }
}

/** Same contract as every other agent's own copy (src/agents/intake.ts, src/agents/frontDesk.ts):
 * the newest HYDRATED `user`-role entry in the transcript — which, for an action row written
 * alongside a `userNote` (src/handler.ts's `submitAction`), is that note, strictly older than the
 * action row it accompanies (`clock_timestamp()` orders them that way on purpose). */
function lastUserText(state: TurnState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!
    if (m.role !== 'user') continue
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (text.length > 0) return text
  }
  return ''
}

/** Adds spend the router's own Jev call has not yet been debited for onto a step some OTHER
 * handler (intake's re-run, the driver) already built — never double-charging, since every
 * `AgentStep` kind already separates "owed" (`costMicros`) from "already debited"
 * (`recordedMicros`).
 *
 * `fail` and `tool` are debited HERE and reported on `recordedMicros`; every other kind rides
 * on `costMicros` and is debited once by the worker.
 *
 * `fail` because it has no `costMicros` field at all to add to — exactly the way
 * `runIntakeTurn`'s own supplier-failure branch debits the intake call it already made.
 *
 * `tool` is the final review's I5, and the reason is less obvious: `src/worker.ts`'s
 * `case 'tool'` only calls `recordSpend(step.costMicros)` in the FRESH branch. A `replayed`
 * branch skips it (the original attempt already paid for that tool call) and `ambiguous`
 * `failTurn`s without it. But on a resumed turn the router makes a genuinely NEW Jev call — a new
 * `model_calls` row with a real `cost_micros` — and folding it into `costMicros` meant it never
 * reached `conversations.spend_usd_micros`. `recordedMicros` is added to the turn total BEFORE
 * the switch, on every path, so it is the field that survives a replay. */
async function withExtraCost(
  sql: postgres.Sql, ctx: AgentContext, step: AgentStep, extra: bigint,
): Promise<AgentStep> {
  if (extra === 0n) return step
  if (step.kind === 'fail' || step.kind === 'tool') {
    await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: extra })
    return { ...step, recordedMicros: (step.recordedMicros ?? 0n) + extra }
  }
  return { ...step, costMicros: step.costMicros + extra }
}

/**
 * An ordinary typed message: one Jev call classifies it, and the router records that call itself
 * (seat `router`) before dispatching further.
 *
 * Factored out of `makeRouter` for results UI pass 2 (F3): a `next` chip click arrives as an
 * `action` row, is validated against the stored `choices` row like any other click, and then runs
 * through exactly this path on the option's LABEL — "Direct flights only" is classified the same
 * way whether she clicked it or typed it, which is the whole point of the chips. `text` is a
 * parameter for that reason rather than being read off the transcript in here.
 */
async function routeTyped(
  deps: IntakeDeps, driver: Agent, ctx: AgentContext, text: string,
): Promise<AgentStep> {
  const { sql } = deps
  const latest = await readLatestResults(sql, ctx.conversationId, ctx.userId)

  // I1: the newest row tells us WHICH search she is looking at (its kind and query); the
  // corpus a filter applies over is the newest UNFILTERED row of that kind, so two successive
  // typed filters do not compound and "show me all flights" can widen back to everything.
  // `?? latest` covers a conversation whose only row of this kind is itself filtered — not a
  // shape this office writes (every search writes its unfiltered results first), so this
  // preserves the old behaviour rather than losing the corpus entirely.
  const base = latest === null
    ? null
    : (await readLatestUnfilteredResults(sql, ctx.conversationId, ctx.userId, latest.kind)) ?? latest

  // Rehydrated from the BASE, which is also what `matchAirlines` wants: a carrier an earlier
  // filter removed is still a carrier she can name.
  let storedItems: StoredItem[] = []
  if (base) {
    const stored = await rehydrate(sql, ctx.conversationId, base.sourceIds)
    storedItems = base.sourceIds.flatMap((id) => {
      const item = stored.get(id)
      return item ? [item] : []
    })
  }
  const carriers = [...new Set(
    storedItems.flatMap((i) => (isFlight(i)
      ? [...i.detail.outbound.carriers, ...(i.detail.inbound?.carriers ?? [])]
      : [])),
  )]

  const result = await routeMessage(
    { jev: deps.jev }, text, latest !== null, { lastQuery: latest?.query ?? null, carriers },
  )
  const cost = await recordJevCall(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'router', request: result.request, response: result.response,
  })

  switch (result.intent) {
    case 'filter': {
      // `hasResults` was false whenever `latest` is null, and `routeMessage` has no reason to
      // answer 'filter' with nothing to filter — but Jev's answer is still a guess, never a
      // guarantee, so this falls back to the driver rather than crash on a missing results row.
      if (!base) return withExtraCost(sql, ctx, await driver(ctx), cost)
      const filter = result.filter ?? {}

      // The bug this office was filed for: "I don't want to stop in China or the Middle East"
      // used to classify as `filter` and change NOTHING, because no dimension matched — and
      // the reply that followed ("Showing 10 of 10: all results.") read as though the office
      // had understood and agreed, rather than as the honest "I didn't follow that" it should
      // have been. An empty `Filter` (nothing in `routeMessage` recognised) gets the fixed
      // admission instead, with whatever chips the conversation's own STAGE calls for — never
      // `nextStepsAttachment('filter')`, since nothing was actually filtered — and no `results`
      // attachment, since the list on screen has not changed. `WIDENS_FILTER` is the one carve
      // out: "show me all flights" also resolves to an empty `Filter`, but it is a deliberate
      // clear, not a failure to understand, and widening back over the unfiltered `base` is
      // exactly what the old "Showing N of N: all results" sentence below is for.
      if (Object.keys(filter).length === 0 && !WIDENS_FILTER.test(text)) {
        const stage = await conversationStage(sql, ctx.conversationId, ctx.userId)
        return {
          kind: 'park',
          message: NO_FILTER_MESSAGE,
          costMicros: cost,
          attachments: [nextStepsAttachment(nextStepsForStage(stage))],
        }
      }

      const filtered = applyFilter(storedItems, filter)
      // Section 8c: the same pattern as the hotels reply — say what is left AND what the best
      // of it is, rather than only the arithmetic. The price is this office's own `formatMoney`
      // output.
      const cheapest = [...filtered].sort(
        (a, b) => (a.price.minor < b.price.minor ? -1 : a.price.minor > b.price.minor ? 1 : 0),
      )[0] ?? null
      // The connections filter's own honesty: the supplier's masked NAME says nothing about
      // why this flight survived "no connections in China or the Middle East", so the cheapest
      // one is described by its airline and where it connects instead — never the supplier's
      // `name`, which `describeCheapestForReply` falls back to only when there is no connections
      // filter active (every other filter keeps the old, supplier-named sentence).
      const hasConnectionsFilter = (filter.avoidCountries?.length ?? 0) > 0 || (filter.avoidRegions?.length ?? 0) > 0
      return {
        kind: 'park',
        message: filterReply(
          filtered.length, storedItems.length, describeFilter(filter),
          cheapest === null ? null
            : { name: describeCheapestForReply(cheapest, hasConnectionsFilter), price: formatMoney(cheapest.price) },
        ),
        costMicros: cost,
        attachments: [
          {
            role: 'results',
            content: { ...base, sourceIds: filtered.map((i) => i.sourceId), filter },
          },
          // F2: after a filter, the two steps that matter are widening back out and the one
          // filter she has not tried yet. The connections filter's own "Show all flights
          // again" chip is this same set — `SETS.filter` (src/agents/nextSteps.ts) already
          // carries it.
          nextStepsAttachment('filter'),
        ],
      }
    }
    case 'new_search': {
      const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
      const lastOrigin = notebook.originCity?.value ?? await readLastOrigin(sql, ctx.userId)
      const step = await runIntakeTurn(deps, ctx, { text, lastOrigin })
      return withExtraCost(sql, ctx, step, cost)
    }
    case 'question':
    case 'chat':
      return withExtraCost(sql, ctx, await driver(ctx), cost)
    case 'faq':
      return { kind: 'park', message: faqAnswer(text), costMicros: cost }
}
}

/**
 * `get_links`'s own answer. The hand-off is a BUTTON (`PinnedSummary`'s "Get booking links" ->
 * `POST /api/proposals/[id]/decide` -> the `hand_off` action -> the driver -> the cashier), so no
 * sentence typed into the composer can start it, and handing this label to `routeMessage` would
 * classify it as chat and spend a driver turn saying nothing useful. A fixed line pointing at the
 * button is both cheaper and true.
 */
const GET_LINKS_REPLY = 'Press "Get booking links" on the summary to the right.'

/** What `change_flight` says when there is no stored flight list left to go back to. */
const NO_FLIGHTS_TO_RESHOW = 'I do not have a flight list to go back to. Tell me the trip again.'

/**
 * `change_flight`: re-show the newest UNFILTERED flights row. A read, not an intent — there is
 * nothing to classify and nothing to search, so this costs no model call of any kind.
 *
 * Unfiltered on purpose, for the same reason a typed filter reads that row (the final review's
 * I1): she is backing out of a choice, and the list she should land on is every flight that
 * search found, not whatever a filter had narrowed it to before she picked one.
 */
async function reshowFlights(sql: postgres.Sql, ctx: AgentContext): Promise<AgentStep> {
  const base = await readLatestUnfilteredResults(sql, ctx.conversationId, ctx.userId, 'flights')
  if (!base) return { kind: 'park', message: NO_FLIGHTS_TO_RESHOW, costMicros: 0n }
  return {
    kind: 'park', message: 'Pick another flight.', costMicros: 0n,
    attachments: [{ role: 'results', content: base }, nextStepsAttachment('flights')],
  }
}

/**
 * `makeRouter(deps)`: the agent that now runs on every `desk === 'planning'` step. First checks
 * whether the newest STORED row (not the hydrated transcript — see `readNewestMessage`'s own doc
 * comment) is an `action`:
 *
 * - `choice` — ledger ruling 2: re-run intake on the original message (the newest hydrated
 *   `user` entry) with `overrides: { [questionId]: optionId }` at confidence 1.
 * - `choose` — Task 7's handler (a stub today).
 * - `refresh` — pass 3's handler: re-run the stored search for that kind (src/agents/refresh.ts).
 * - `hand_off` / `rejected` / `revise` / anything else (including an unreadable action row) — the
 *   driver, same as before Task 6.
 *
 * Otherwise it is an ordinary typed message: `routeMessage` classifies it, and the router records
 * that call itself (seat `router`) before dispatching further.
 */
export function makeRouter(deps: IntakeDeps): Agent {
  const driver = makeDriver(deps)
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql } = deps
    const newest = await readNewestMessage(sql, ctx.conversationId, ctx.userId)

    if (newest && newest.role === 'action') {
      const action = parseAction(newest.content)
      if (action?.action === 'choice') {
        // Fix round 1 (Important): `ActionPayload`'s own regex only proves `questionId`/
        // `optionId` are id-SHAPED, never that they were actually offered — a stale card re-sent
        // after a later choice card replaced it, or a forged id, must not reach `runIntakeTurn`
        // at confidence 1. Checked BEFORE any Jev call, so a refusal here costs nothing.
        const latestChoices = await readLatestChoices(sql, ctx.conversationId, ctx.userId)
        const offered = latestChoices !== null
          && latestChoices.choices.questionId === action.questionId
          && latestChoices.choices.options.some((o) => o.id === action.optionId)
        if (latestChoices === null || !offered) {
          return { kind: 'park', message: 'That option is no longer available. Tell me in your own words.', costMicros: 0n }
        }
        // F3: a `next` chip is NOT an answer to a question this office asked, so it must never
        // become an intake override. Two of its ids the router answers itself (see
        // `GET_LINKS_REPLY` and `reshowFlights`); every other one is a sentence she could have
        // typed, and the `userNote` row `submitAction` wrote already carries that label — so the
        // rest of this turn is the ordinary typed path, running on her click as if typed.
        if (action.questionId === NEXT_QUESTION_ID) {
          if (action.optionId === 'get_links') {
            return { kind: 'park', message: GET_LINKS_REPLY, costMicros: 0n }
          }
          if (action.optionId === 'change_flight') return reshowFlights(sql, ctx)
          return routeTyped(deps, driver, ctx, lastUserText(ctx.state))
        }

        const overrides: Partial<Record<'origin' | 'destination' | 'outbound', string>> = {}
        if (action.questionId === 'origin' || action.questionId === 'destination' || action.questionId === 'outbound') {
          overrides[action.questionId] = action.optionId
        }
        // C3: NOT `lastUserText(ctx.state)`. `submitAction` writes her click as a `user` row
        // (the option's label) immediately before the `action` row, and `loop()` hydrates every
        // `user` row into the transcript, so the newest `user` entry is "Barcelona" — not "a
        // week somewhere, flying from where I usually do". Ruling 2 says intake re-runs on the
        // ORIGINAL message with the override applied, and the card's own `created_at` is the
        // line between what she typed and what she clicked.
        //
        // `?? lastUserText(...)` is a shape production cannot reach (`submitMessage` writes the
        // first `user` row of every conversation, and intake only offers a card after reading
        // it), so the fallback is there to keep a malformed transcript from re-running intake on
        // an empty string rather than because it is expected to fire.
        const original = await readNewestUserTextBefore(
          sql, ctx.conversationId, ctx.userId, latestChoices.createdAt,
        )
        return runIntakeTurn(deps, ctx, { text: original ?? lastUserText(ctx.state), overrides })
      }
      if (action?.action === 'choose') {
        return handleChoose(deps, ctx, { kind: action.kind, sourceId: action.sourceId })
      }
      // Pass 3: "Refresh prices" on the stale banner. A search, so it belongs beside `choose`
      // rather than with the driver — see src/agents/refresh.ts.
      if (action?.action === 'refresh') {
        return handleRefresh(deps, ctx, { kind: action.kind })
      }
      // hand_off / rejected / revise, and an unreadable action row (parseAction returned null —
      // `loop()`'s own hydration already told the model so via UNREADABLE_ACTION_TEXT): all go
      // to the driver, exactly as they did before this task.
      return driver(ctx)
    }

    return routeTyped(deps, driver, ctx, lastUserText(ctx.state))
  }
}

