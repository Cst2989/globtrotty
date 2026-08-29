import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import type { Limits, LoopMessage } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import {
  buildCountTokensRequest, callModel, estimateInputTokens,
  type CallArgs, type ModelResult, type Transport,
} from '../model/client.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { costMicros } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { toolsForDesk } from '../tools/registry.js'
import { fenceResult, trimForContext, validateToolCall } from '../tools/validate.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { applyRequirementsPatch, loadNotebook, renderNotebook } from '../repo/notebook.js'
import { constraintsFromNotebook, runGates } from '../gates/pipeline.js'
import { recordResults } from '../repo/toolResults.js'
import { formatMoney } from '../money.js'
import type { FlightSearch, HotelSearch, Supplier, SupplierItem } from '../supplier/types.js'
import type { Notebook, Provenance } from '../notebook.js'

/**
 * `import.meta.url`, never `__dirname` — this package is `"type": "module"` with
 * NodeNext resolution, where `__dirname` is undefined. The prompt is a file so
 * `promptVersion` points at something a human reviews and a prompt change is a
 * reviewable diff. There is no build step (tsx and vitest only), so the relative
 * URL resolves against the source tree at run time.
 */
const SYSTEM = readFileSync(new URL('./prompts/driver.md', import.meta.url), 'utf8')

const DESK = 'planning' as const

export type DriverDeps = {
  sql: postgres.Sql
  transport: Transport
  flights: Supplier
  hotels: Supplier
  limits: Limits
  now: () => number
}

/**
 * The planning desk, as plan 1's `Agent`: one invocation is one model call plus,
 * if the model asked for one, one tool execution. `loop()` calls it again for
 * the next step, so the harness's claim, fencing, heartbeat, sweeper and
 * completion machinery is untouched.
 *
 * ## Who charges for the model call
 *
 * This function does, and exactly once. Spec section 8 requires a reservation
 * BEFORE dispatch, so the driver has already debited
 * `conversations.spend_usd_micros` and `daily_usage` by the time it returns —
 * which is why every step it returns carries `costMicros: 0n` and reports the
 * real figure in `recordedMicros`. `loop()` adds `recordedMicros` to the turn
 * total and never passes it to `recordSpend`; a positive `costMicros` here would
 * apply the identical increment a second time and bill every driver call twice.
 */
export function makeDriver(deps: DriverDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql, limits } = deps
    const seat = SEATS.driver
    const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)

    const args: CallArgs = {
      seat,
      system: SYSTEM,
      messages: ctx.state.messages,
      tools: toolsForDesk(DESK),
      // The notebook is volatile: it changes the moment she states a fact.
      // `suffix` lands after the last cache breakpoint, so it never invalidates
      // the cached prefix behind it (spec section 7).
      suffix: renderNotebook(notebook),
    }

    // ---- 1. Reserve an upper bound BEFORE dispatch (spec section 8) ---------
    const inputTokens = deps.transport.countTokens
      ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
      : estimateInputTokens(args)
    const reserved = estimateMicros(seat, inputTokens)
    // `day` is threaded from here into every reconcile below and is NEVER
    // recomputed. A driver call — extended thinking included — can be in flight
    // across UTC midnight, and a recomputed "today" would land the reservation
    // on yesterday's bucket and the refund on today's: an overcount on one day
    // and an UNDERCOUNT of up to a whole driver reservation on the other. See
    // reconcile's doc comment; taking the day as an argument is what removes
    // the possibility structurally, and passing a fresh one here would put it
    // straight back.
    const { conversationMicros, dailyMicros, day } = await reserve(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved,
    })
    const refund = () => reconcile(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day,
    })

    // The ceiling reads the values `reserve` RETURNED. Reading either counter
    // before the turn began is the v1 staleness defect spec section 8 names: a
    // runaway 12-step turn passed the same stale check a dozen times. Both
    // counters `reserve` reports are checked, because it reports both and a
    // ceiling nobody compares against is not a ceiling. The GLOBAL ceiling is
    // not checked here: `reserve` does not read it, and `decideNext` already
    // checks all three from `readSpendFailClosed` before this agent is called.
    const conversationCapped = conversationMicros >= limits.conversationCeilingMicros
    if (conversationCapped || dailyMicros >= limits.dailyCeilingMicros) {
      await refund()
      return {
        kind: 'fail',
        reason: 'limit_reached',
        // Which ceiling fired changes what she can DO about it, so the two are
        // not collapsed into one sentence: a capped conversation is fixed by
        // starting another one, and a capped day is not.
        message: conversationCapped
          ? 'This conversation has reached its spending limit, so I have stopped here '
            + 'rather than run up more. Start a new conversation and I will pick up '
            + 'from what we agreed.'
          : 'We have reached today\u2019s spending limit, so I have stopped here rather '
            + 'than run up more. Come back tomorrow and I will pick up from what we '
            + 'agreed.',
        recordedMicros: 0n,
      }
    }

    // ---- 2. Call, and classify before touching content ----------------------
    // A throw here leaves the reservation debited unless the taxonomy can say the
    // call was never billed. `billed === 'no'` means a response BODY reached us
    // (any status: 400 through 503) and an error body carries no `usage`, so the
    // whole reservation is refunded. `'unknown'` — a connection failure, a
    // timeout, our own abort, or an error we cannot name — keeps the debit,
    // because the provider may have generated and billed a response we never saw.
    //
    // Getting this wrong in the other direction is not a rounding error: an
    // outage produces 429s and 5xx, ~400,000 stranded micros per attempt land in
    // `daily_usage`, and `readSpendFailClosed` sums that column across ALL USERS
    // for the global ceiling — so a few hundred failed calls would cap the whole
    // product for the rest of the UTC day at zero real spend, with no operator
    // lever short of a manual `daily_usage` write.
    //
    // Rethrown either way: `runTurn`'s catch classifies it again and fails the
    // turn. This block decides the MONEY, not the outcome.
    let result: ModelResult
    try {
      result = await callModel(deps.transport, args, deps.now)
    } catch (err) {
      if (classifyError(err).billed === 'no') await refund()
      throw err
    }

    // Priced on the seat's model, not `result.model`: the response echoes back a
    // name that may be an alias we have no price row for, and PRICES throws
    // rather than charging zero. SYSTEM_CACHE_TTL is the TTL cacheableSystem
    // actually put on the wire — a 1h write bills at 2x input (Task 2b).
    const actual = result.kind === 'refused'
      ? 0n
      : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)

    // Not best-effort: this is the spend, and a turn that cannot record it stops.
    await reconcile(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day,
    })
    // Best-effort: this is the span. Its failure is swallowed inside.
    await recordModelCall(sql, {
      conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
      seat: 'driver', seatConfig: seat, result,
      systemPrompt: args.system, userPrompt: lastUserText(ctx.state.messages),
      thinkingMode: 'adaptive', costMicros: actual,
    })

    if (result.kind === 'refused') {
      // Spec section 8: fails the turn, and does not consume quota — the
      // reservation above was reconciled to 0n, so the counter is back where it
      // started. `recordedMicros: 0n` says so explicitly rather than by omission.
      return {
        kind: 'fail',
        reason: 'refused',
        message: 'I can’t help with that request. If you tell me what trip you are '
               + 'trying to plan, I will pick it up from there.',
        recordedMicros: 0n,
      }
    }

    // ---- 3. No tool: her answer --------------------------------------------
    const toolUse = result.content.find((b) => b.type === 'tool_use')
    if (toolUse === undefined || toolUse.type !== 'tool_use') {
      const text = result.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n').trim()
      return {
        kind: 'message',
        // A `max_tokens` stop can leave the content empty. She gets words either
        // way: a blank agent message is the failure mode a refusal branch exists
        // to prevent, and it would be absurd to reintroduce it here.
        text: text.length > 0
          ? text
          : 'I ran out of room mid-thought. Ask me again and I will keep it shorter.',
        costMicros: 0n,
        recordedMicros: actual,
      }
    }

    // ---- 4. A tool: allowlist and zod, before any durable write -------------
    const check = validateToolCall(DESK, toolUse.name, toolUse.input)

    /**
     * The assistant turn as it goes back into the transcript: everything the
     * model said, MINUS any sibling `tool_use` block.
     *
     * Parallel tool use is on by default and `buildRequest` sends no
     * `tool_choice`, so one response can legitimately carry two `tool_use`
     * blocks. An `AgentStep` answers exactly one of them, and `loop()` appends
     * this content followed by a single `tool_result` — so echoing both would
     * put an unanswered `tool_use` into the next request, which is a 400 and a
     * dead turn, not a degraded answer. Dropping the sibling costs the model
     * one round trip to re-ask for it; keeping it costs the whole turn.
     *
     * Thinking blocks are untouched: extended thinking must be echoed back
     * byte-for-byte or it is rejected.
     */
    // Compared by `id`, not by reference: identical cost, and it still holds if
    // anything upstream ever hands back a cloned `content` array.
    const assistantContent =
      result.content.filter((b) => b.type !== 'tool_use' || b.id === toolUse.id)

    const asToolStep = (run: () => Promise<unknown>): AgentStep => ({
      kind: 'tool',
      // The PROVIDER's id. plan 1's tool_calls primary key is (turn_id, call_id),
      // so a resumed turn that re-issues the same id is recognised as the same
      // call rather than executed twice.
      callId: toolUse.id,
      name: toolUse.name,
      run,
      costMicros: 0n,
      recordedMicros: actual,
      assistantContent,
    })

    if (!check.ok) {
      // A rejection travels the SAME durable path as a result — a tool step whose
      // run() resolves to text. tool_calls records that the attempt happened, and
      // the model gets one round trip to correct itself instead of a dead turn.
      return asToolStep(async () => check.content)
    }

    if (check.def.name === 'ask_user') {
      // Terminal by construction: the answer comes from her, not from a tool.
      // Nothing is written to `turns.state` on this path: `loop()` returns from
      // the park branch before the state mutation, so the tool_use the model
      // just emitted never enters the saved transcript at all.
      const { questions } = check.input as { questions: string[] }
      return {
        kind: 'park', message: questions.join('\n\n'),
        costMicros: 0n, recordedMicros: actual,
      }
    }

    if (check.def.door === 'api') {
      const budget = await assertSupplierBudget(sql, ctx.turnId, limits.maxSupplierCallsPerTurn)
      if (!budget.ok) {
        return asToolStep(async () =>
          `You have used all ${budget.max} supplier searches for this turn `
          + `(${budget.used} so far). No more searches will run. Propose from what you `
          + `already have, or ask her a question.`)
      }
    }

    return asToolStep(async () => {
      const raw = await execute(deps, ctx, notebook, check.def.name, check.input)
      // TRIM, then FENCE. Fencing first and trimming second would cut the
      // closing delimiter off a long result and hand the model an unterminated
      // fence — the exact structure the fence exists to make unambiguous.
      return fenceResult(check.def.name, check.def.door, trimForContext(raw))
    })
  }
}

/** The last thing she actually said, for the ledger's `user_prompt`. */
function lastUserText(messages: LoopMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (text.length > 0) return text
  }
  return ''
}

/**
 * The trip currency, or EUR when she has not named one.
 *
 * Deliberately NOT the same decision `constraintsFromNotebook` makes, and the
 * asymmetry is the point. A GATE with no currency refuses to evaluate rather
 * than invent one; a SEARCH has to name a currency to be issued at all, and
 * refusing to search until she states a budget would make the desk useless on
 * the first turn. The invented value is confined to the search request, never
 * written to the notebook, and never compared against a budget she did not set.
 */
const currencyOf = (nb: Notebook): string => nb.budget === null ? 'EUR' : nb.budget.value.currency

/**
 * Whose word this patch is recording — decided from the transcript, at the
 * moment of the call, and never by the model (the tool schema carries no
 * `source` field).
 *
 * ## Why this is not the constant `'user'`
 *
 * A constant would have left the entire provenance system with no reachable
 * caller: `applyRequirementsPatch` is `applyRequirements`' only production
 * caller, so a hardcoded `'user'` makes src/notebook.ts's `source === 'tool'`
 * budget refusal and its `source !== 'user'` relax-guard dead code, and the
 * module that exists to stop an inferred value relaxing something she said
 * would stop nothing.
 *
 * That is reachable WITHOUT an adversary. A supplier result reaches the model's
 * context fenced but present (renderItems -> fenceResult -> loop()'s
 * `tool_result` block -> the next invocation's `args.messages`). The model reads
 * "cheapest is EUR 1,650" against her EUR 1,500 budget, calls
 * `update_requirements` to make its plan work, and — stamped `'user'` — both
 * guards pass, the budget is relaxed by a number the MODEL chose, and
 * `constraintsFromNotebook` hands it to the money gate, which then passes a
 * proposal it was built to reject.
 *
 * ## Why it is not the constant `'inferred'` either
 *
 * `'inferred'` trips the relax-guard on every constraint field, so once she set
 * a budget she could never raise it again through this desk — the rule inverted
 * rather than enforced. Provenance is not a constant.
 *
 * ## What the transcript actually tells us
 *
 * `loop()` hydrates a fresh turn from `messages` as role + text only, so step 0
 * of every turn is provably her words alone. A `tool_result` block in this
 * turn's transcript means something untrusted has already been ingested and the
 * model is no longer transcribing only what she said.
 *
 * The cost to her is nothing she would notice: before any search she may relax
 * anything she likes, after a search a patch may still TIGHTEN or establish a
 * first value (the guard only blocks relaxations), and her next message starts a
 * clean transcript.
 */
function provenanceFor(ctx: AgentContext): Provenance {
  const tainted = ctx.state.messages.some(
    (m) => m.content.some((b) => b.type === 'tool_result'),
  )
  return tainted ? 'inferred' : 'user'
}

/**
 * One handler per advertised tool. Every name in `DESK_TOOLS.planning` appears
 * here — an advertised tool with no handler is a tool the model will call and get
 * an error from, and the `default` below exists only so the compiler does not
 * have to trust that claim.
 */
async function execute(
  deps: DriverDeps, ctx: AgentContext, notebook: Notebook, name: string, input: unknown,
): Promise<string> {
  const { sql } = deps
  switch (name) {
    case 'explore_flights': {
      const i = input as {
        from: string; to: string; departureDate: string
        returnDate?: string | null; adults: number
      }
      const party = notebook.partySize === null ? null : notebook.partySize.value
      const params: FlightSearch = {
        kind: 'flight', from: i.from, to: i.to,
        departureDate: i.departureDate,
        returnDate: i.returnDate === undefined ? null : i.returnDate,
        flexDays: 0,
        adults: i.adults,
        // From the NOTEBOOK, not from the model: the tool schema has no field
        // for either, and children and infants are priced differently from
        // adults. A search that silently drops them prices a trip for a party
        // that is not hers.
        children: party === null ? 0 : party.children,
        infants: party === null ? 0 : party.infants,
        cabinClass: 'Economy', currency: currencyOf(notebook),
        maxStops: notebook.maxStops === null ? null : notebook.maxStops.value,
        allowSelfTransfer: false,
      }
      const items = await deps.flights.search(params)
      await recordResults(sql, {
        conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
      })
      return renderItems(items)
    }
    case 'explore_hotels': {
      const i = input as { query: string; checkIn: string; checkOut: string; adults: number }
      const params: HotelSearch = {
        kind: 'hotel', query: i.query, checkIn: i.checkIn, checkOut: i.checkOut,
        adults: i.adults, currency: currencyOf(notebook),
      }
      const items = await deps.hotels.search(params)
      await recordResults(sql, {
        conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, params, items,
      })
      return renderItems(items)
    }
    case 'update_requirements': {
      const { patch } = input as { patch: unknown }
      const { next, rejected } = await applyRequirementsPatch(sql, {
        conversationId: ctx.conversationId, userId: ctx.userId, patch,
        source: provenanceFor(ctx),
      })
      // A rejection names the KEYS that caused it, and the notebook is rendered
      // back underneath either way. `applyRequirements` rejects two different
      // ways — an unrecognised or malformed key discards the WHOLE patch, while
      // a refused constraint (a currency change, a relaxation) drops just that
      // field — so neither "recorded" nor "nothing was recorded" is true in
      // general. The rendered notebook is the authoritative answer to "what
      // landed?", which is why it is always sent rather than only on success.
      const head = rejected.length === 0
        ? 'Recorded. The notebook now reads:'
        : `Refused: ${rejected.join(', ')}. An unrecognised or malformed key discards the `
          + 'whole patch, so read what the notebook says below before relying on the rest. '
          + 'Do not re-send a refused key; ask her instead. The notebook now reads:'
      return `${head}\n\n${renderNotebook(next)}`.trimEnd()
    }
    case 'propose_itinerary': {
      // ProposalRefsSchema is z.strictObject({refs: [...]}) — an OBJECT wrapping
      // the array, because a bare array is not a legal top-level tool schema. So
      // the validated input must be unwrapped: runGates wants the array.
      const { refs } = input as { refs: unknown[] }
      const outcome = await runGates(sql, {
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
        refs,
        notebook: constraintsFromNotebook(notebook),
        now: new Date(deps.now()),
        // Set deliberately. `gate_results.round` has no uniqueness constraint yet
        // and the reviewer's multi-round loop is plan 3b; until then every
        // proposal in a turn is round 0, which is honest rather than invented.
        round: 0,
      })
      if (outcome.ok) {
        return `Proposal accepted. Total ${formatMoney(outcome.total)}. `
             + `Items: ${outcome.items.map((i) => i.item.sourceId).join(', ')}. `
             + 'Tell her what you chose and why.'
      }
      return 'The proposal was rejected. Fix exactly these and propose again:\n'
           + outcome.violations
               .map((v) => `- ${v.gate} (${v.sourceIds.join(', ') || 'no ids'}): ${v.detail}`)
               .join('\n')
    }
    default:
      // Unreachable: validateToolCall already refused anything not in
      // DESK_TOOLS.planning. Kept so adding a tool to the registry without a
      // handler is a readable message rather than an undefined.
      return `No handler for "${name}" at this desk.`
  }
}

/**
 * Search results as REFERENCES plus the supplier's own prices. The prices are
 * real — they came from the supplier and were written to the corpus in the same
 * breath — and she needs them to choose. What the model may not do is restate one
 * in a proposal: `propose_itinerary` takes references only, and every value is
 * rehydrated from this corpus server-side (spec section 5).
 */
function renderItems(items: SupplierItem[]): string {
  if (items.length === 0) return 'No results. Try different dates or a nearby airport.'
  return items
    .map((i) => `${i.sourceId} — ${i.name} — ${formatMoney(i.price)} (${i.priceBasis})`)
    .join('\n')
}
