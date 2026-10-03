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
import type { Filter, ResultsContent } from '../results.js'
import { isFlight, type StoredItem } from '../supplier/types.js'
import { runIntakeTurn, type IntakeDeps } from './intake.js'
import { makeDriver } from './driver.js'
import { handleChoose } from './choose.js'
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
 * (`recordedMicros`); a `fail` step has neither to add to, so its share is debited directly,
 * exactly the way `runIntakeTurn`'s own supplier-failure branch debits the intake call it already
 * made. */
async function withExtraCost(
  sql: postgres.Sql, ctx: AgentContext, step: AgentStep, extra: bigint,
): Promise<AgentStep> {
  if (extra === 0n) return step
  if (step.kind === 'fail') {
    await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: extra })
    return { ...step, recordedMicros: (step.recordedMicros ?? 0n) + extra }
  }
  return { ...step, costMicros: step.costMicros + extra }
}

/**
 * `makeRouter(deps)`: the agent that now runs on every `desk === 'planning'` step. First checks
 * whether the newest STORED row (not the hydrated transcript — see `readNewestMessage`'s own doc
 * comment) is an `action`:
 *
 * - `choice` — ledger ruling 2: re-run intake on the original message (the newest hydrated
 *   `user` entry) with `overrides: { [questionId]: optionId }` at confidence 1.
 * - `choose` — Task 7's handler (a stub today).
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
      // hand_off / rejected / revise, and an unreadable action row (parseAction returned null —
      // `loop()`'s own hydration already told the model so via UNREADABLE_ACTION_TEXT): all go
      // to the driver, exactly as they did before this task.
      return driver(ctx)
    }

    const text = lastUserText(ctx.state)
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
        const filtered = applyFilter(storedItems, result.filter ?? {})
        return {
          kind: 'park',
          message: `Showing ${filtered.length} of ${storedItems.length}: ${describeFilter(result.filter ?? {})}.`,
          costMicros: cost,
          attachments: [{
            role: 'results',
            content: { ...base, sourceIds: filtered.map((i) => i.sourceId), filter: result.filter ?? {} },
          }],
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
}
