import type postgres from 'postgres'
import { classifyDesk } from '../classify.js'
import type { ModelClient } from '../client.js'
import { TODAY } from '../conversation.js'
import { loadDesk, renderPrompt } from '../desks.js'
import { textOfBlocks, whichCeiling, type ContentBlock, type Limits } from '../engine.js'
import { isUnbilled } from '../errors.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { callModel, estimateInputTokens, type CallArgs, type ModelResult } from '../model/client.js'
import { costMicros } from '../pricing.js'
import type { Provenance } from '../notebook.js'
import { readDeskDecision, writeDesk } from '../repo/conversations.js'
import { readUserMemory, renderMemory } from '../repo/memory.js'
import { capturePolicyFor, pgSink } from '../repo/model-calls.js'
import { loadNotebook, renderNotebook } from '../repo/notebook.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { SEATS, type SeatName } from '../seats.js'
import type { ToolRunner } from '../tools.js'
import { toolsForDesk, type Desk } from '../tools/registry.js'
import { assertSupplierBudget, supplierCallCost } from '../tools/supplierBudget.js'
import { makeNonce, validateToolCall } from '../tools/validate.js'
import type { Agent, AgentContext, AgentStep } from '../worker.js'

export type DriverDeps = {
  sql: postgres.Sql
  client: ModelClient
  /**
   * The runner chain, built by whoever constructs the driver, so the driver
   * knows nothing about the ledger, the corpus, the gates or the cashier. Tier 3
   * hands it all nine wrappers (netlify/functions/run-turn-background.mts), and
   * `npm run trip` hands it the same nine minus `ledgerRunner`, which is eight.
   * A test hands it `mockRunner()`.
   */
  run: ToolRunner
  limits: Limits
  now: () => number
}

/**
 * The planning desk, as module 3's `Agent`: one invocation is one model call
 * plus, if the model asked for one, one tool execution. `loop()` (src/worker.ts)
 * calls it again for the next step, so the claim, the fencing token, the
 * heartbeat, the sweeper and the completion machinery are all untouched. The
 * whole difference from lesson 4.6 is that a step is now a call rather than a
 * conversation, which is what lets a released turn be picked up mid conversation
 * instead of started again.
 *
 * ## Who charges for the model call
 *
 * This function does, exactly once, through `reserve` and `reconcile`. It never
 * calls `recordSpend` and it is never given `ledgerSink`: `ledgerSink` calls
 * `recordSpend` on top of whatever the caller already did, so handing it to a
 * driver that has already debited the same micros is the double charge in one
 * line. It writes its observability row through `pgSink` instead, which touches
 * no money at all.
 *
 * Every step it returns therefore carries the real figure in `costMicros` WITH
 * `alreadyRecorded: true`. `runTurn` adds the figure to `turns.spend_usd_micros`
 * and, seeing the flag, does not put it through `recordSpend` a second time.
 *
 * ## Which desk
 *
 * Whichever `selectDesk` chose, from lesson 5.3: one cheap structured-output call
 * per turn, remembered on `course.conversations.desk` and reused by every later
 * step, by every retry of a step and by a resume that comes back on step 0. A
 * factual question is answered by the front desk on Haiku, which publishes no
 * tools at all, so a front-desk step can only ever return a message; the
 * `tool_use` branch below is unreachable for it by construction and not by a
 * check.
 */
export function makeDriver(deps: DriverDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql, limits } = deps
    // The routing call reserves and checks the ceiling exactly the way the call
    // below does, so a capped conversation stops before it, not after it.
    const chosen = await selectDesk(deps, ctx)
    if (chosen.kind === 'limit') return limitReachedStep(chosen.reached, 0n)
    const { desk: deskName, costMicros: routingMicros } = chosen
    const desk = loadDesk(deskName)
    const seat = deskName === 'front' ? SEATS.front_desk : SEATS.driver
    // The row's label follows the seat, and does not stay the literal 'driver'
    // lesson 5.1 wrote when the driver had one desk. `group by seat` over
    // course.model_calls is how an FAQ turn is shown to be a Haiku turn, and a
    // front-desk call recorded as 'driver' would make that query answer with the
    // opposite of the truth.
    const seatName: SeatName = deskName === 'front' ? 'front_desk' : 'driver'

    // Only the planning desk has a notebook and a memory to carry. The front
    // desk holds no tools, so nothing it can do reads a requirement or acts on
    // a remembered preference, and rendering either into its request would be
    // paying input tokens to tell a desk about things it cannot act on. Both
    // reads are skipped with it.
    let suffix: string | undefined
    if (deskName !== 'front') {
      const [notebook, facts] = await Promise.all([
        loadNotebook(sql, ctx.conversationId, ctx.userId),
        readUserMemory(sql, ctx.userId),
      ])
      // No source facts yet, and an empty map rather than a query: no PRODUCTION
      // path writes course.source_memory, so a read of it could only ever come
      // back empty and a per-turn query for it would be a round trip for
      // nothing. `rememberSourceFact` exists and test/memory.test.ts calls it,
      // which is what pins the reader and the render against a real table. The
      // writer arrives with the module that learns a fact about a property.
      // `readSourceMemory` is what will scope it to the keys that turn's corpus
      // actually holds when it does.
      const sourceFacts = new Map<string, string[]>()
      // Memory first and the notebook second, so the notebook, which changes
      // most often, is the last thing in the request.
      suffix = [renderMemory(facts, sourceFacts, makeNonce()), renderNotebook(notebook)]
        .filter((s) => s.length > 0).join('\n\n')
    }
    const args: CallArgs = {
      seat,
      // Only {{today}} now, and the front desk takes no slot at all: it answers
      // from what she asked and has no dates to reason about. The notebook used
      // to be rendered into {{requirements}} and {{dropped}} inside the system
      // prompt, which is the stable prefix lesson 5.6 caches, so every fact she
      // stated would have thrown that prefix away. It rides in the suffix
      // instead.
      system: renderPrompt(desk, deskName === 'front' ? {} : { today: TODAY }),
      messages: ctx.state.messages,
      // Empty for the front desk, so `buildRequest` omits `tools` entirely and
      // the model is offered no door to open.
      tools: toolsForDesk(deskName),
      // Memory and the notebook are both volatile: the notebook changes the
      // moment she states a fact, and memory changes the moment one is learned.
      // The suffix lands after the last block of the transcript, and from this
      // lesson after the last cache breakpoint, so neither invalidates the
      // cached prefix behind it.
      suffix,
    }

    // ---- 1. Reserve an upper bound BEFORE dispatch (SPEC section 8) ---------
    const reserved = estimateMicros(seat, estimateInputTokens(args))
    // `day` is threaded from here into every reconcile below and is never
    // recomputed. A driver call with extended thinking can be in flight across
    // UTC midnight, and a fresh "today" would land the reservation on one
    // bucket and the refund on another.
    const { conversationMicros, dailyMicros, day } = await reserve(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved,
    })
    // Guarded, the way every refund in `runScouts` is (src/agents/scout.ts). Both
    // callers below are already on a path that has decided what this step
    // returns: one is about to hand back a `limit_reached` step the model can
    // act on, the other is re-throwing an error the taxonomy has classified. A
    // bare `reconcile` would let a failed bookkeeping write replace either with
    // a database error, which turns a recoverable ending into a failed turn and
    // points the one log line at the wrong system. What is stranded instead is
    // the refund itself, which fails closed: the ceiling then counts more spend
    // than really happened, never less.
    const refund = async () => {
      try {
        await reconcile(sql, {
          userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day,
        })
      } catch (refundErr) {
        console.error(
          `makeDriver: the refund for turn ${ctx.turnId} step ${ctx.state.step} failed. `
          + `${reserved} micros stay reserved against this conversation and this day`,
          refundErr,
        )
      }
    }

    // The ceiling reads the values `reserve` RETURNED, not a reading from before
    // this call. `decideNext`'s own check at the top of `loop()` (src/worker.ts)
    // is the only other one, it ran before this step began, and it knows nothing
    // about the reservation this step has just made. Until this lesson that
    // check was the whole guard and one step was the whole of `turn()`, so a
    // dozen model calls could run behind a single reading of the counters.
    // `globalMicros` is not read here: `reserve` does not touch it, and
    // `decideNext` has already checked all three from `readSpendFailClosed`
    // before this agent was called, so only 'conversation' or 'daily' can fire.
    const reached = whichCeiling(
      { conversationMicros, dailyMicros, globalMicros: 0n }, limits,
    )
    if (reached !== null) {
      await refund()
      // The routing call, and nothing else. It happened before the ceiling was
      // read, it produced an answer, and `turns.spend_usd_micros` has to carry
      // it or a capped turn would report itself free. The step `selectDesk`
      // returns when ITS own reservation fires the ceiling carries zero for the
      // opposite reason: that call never went out.
      return limitReachedStep(reached, routingMicros)
    }

    // ---- 2. Call, and classify before touching content ----------------------
    // A throw here leaves the reservation debited unless we can say the call was
    // never billed. An error BODY reaching us, at any status from 400 to 503,
    // carries no usage: the provider answered with a refusal to serve rather
    // than with a generation, so nothing was billed and the whole reservation is
    // refunded. That is both halves of the taxonomy that carry a status,
    // `provider_rejected` (the remaining 4xx) and `provider_down` (408, 409,
    // 429 and every 5xx), and `isUnbilled` (src/errors.ts) names both, from
    // lesson 5.4 where the scouts became its second caller. A connection
    // failure, a timeout with no response at all or our own abort keeps the
    // debit, because the provider may have generated and billed a response we
    // never saw.
    //
    // Refunding only one half is not a rounding error. `withRetry`
    // (src/retry.ts) wraps the whole agent step at src/worker.ts, so one step
    // against a 503-ing provider reserves three times, and roughly 400,000
    // stranded micros per attempt land in course.daily_usage.
    // `readSpendFailClosed` (src/repo/spend.ts) sums that column across ALL
    // USERS for the global ceiling, so on the order of forty failed steps would
    // cap the whole product for the rest of the UTC day at zero real spend, with no
    // lever short of a manual write. `test/driver.test.ts` drives three failed
    // attempts through THIS call and holds both counters at the routing call's
    // cost and nothing more; the case beside it puts the outage on the routing
    // call instead, where the step never reaches this line, and holds both at
    // zero.
    let result: ModelResult
    try {
      result = await callModel(deps.client, { ...args, signal: ctx.signal }, deps.now)
    } catch (err) {
      if (isUnbilled(err)) await refund()
      throw err
    }

    // Priced on the seat's model, not on `result.model`: the response echoes a
    // name that may be an alias with no price row, and PRICES throws rather than
    // charging zero.
    // The TTL is `SYSTEM_CACHE_TTL`, the same constant `cacheableSystem`
    // (src/model/cache.ts) actually put on the system head a few lines above,
    // rather than a locally chosen '1h' string, so the two cannot drift apart.
    // It does not describe the whole request: the transcript breakpoints go on
    // at the five minute default, so this call writes at two rates at once.
    // `costMicros` prices them apart from `result.usage.cache_creation` where
    // the provider reports it, and charges the whole write at this constant
    // where it does not, which is the dearer rate and therefore the direction a
    // spend figure is allowed to be wrong in.
    const actual = result.kind === 'refused'
      ? 0n
      : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)

    // Not best effort: this is the spend, and a turn that cannot record it stops.
    await reconcile(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day,
    })
    // Best effort: this is the span. `pgSink` swallows and logs its own failure,
    // because losing an observability row must never fail a turn she paid for.
    // The asymmetry with the line above is deliberate and easy to erode, since
    // both look like "write a row after the call": a row that describes what
    // happened may be lost, a row that decides what may happen next may not.
    //
    //
    // The capture, from lesson 5.7. `capturePolicyFor` is asked here rather than
    // left to `pgSink` to infer, because the policy is a fact about the SEAT and
    // this is the only place that knows both the seat and the bytes. The
    // redaction is not done here and is deliberately `pgSink`'s: a redaction a
    // caller applies is a redaction the next caller forgets.
    //
    // `userPrompt` is the last thing said to the model on this call and not the
    // whole transcript. The transcript is already durable in
    // `course.turns.state`, and copying it into a column on every step would
    // store one conversation a quadratic number of times.
    const systemPrompt = args.system
    const userPrompt = textOfBlocks(ctx.state.messages.at(-1)?.content ?? [])
    await pgSink(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, turnId: ctx.turnId,
    })({
      seat: seatName, seatConfig: seat, promptVersion: desk.promptVersion,
      modelRequested: seat.model, modelReturned: result.model,
      usage: result.usage, costMicros: actual, latencyMs: result.latencyMs,
      requestId: result.requestId,
      capturePolicy: capturePolicyFor(
        seatName,
        Buffer.byteLength(systemPrompt, 'utf8'),
        Buffer.byteLength(userPrompt, 'utf8'),
      ),
      systemPrompt, userPrompt,
      // Read off the seat by the same rule `buildRequest` applies when it
      // assembles the request: a seat with an effort setting is an Opus 5 seat
      // and gets adaptive thinking, a seat without one is Haiku and gets
      // neither. SPEC section 7 names a silently changed provider DEFAULT as a
      // drift vector, so what we ASKED for belongs in the row.
      thinkingMode: seat.effort !== null ? 'adaptive' : null,
      response: result.kind === 'refused'
        ? { stop_reason: 'refusal',
            stop_details: { category: result.category, explanation: result.explanation } }
        : { stop_reason: result.stopReason, content: result.content },
    })

    if (result.kind === 'refused') {
      // SPEC section 8: a refusal fails the turn and does not consume quota. The
      // reservation above was reconciled to 0n, so the counter is back where it
      // started, and `alreadyRecorded` says so rather than leaving it to be
      // inferred from a zero.
      //
      // A refusal refunds its OWN reservation in full. It does not refund the
      // routing call that decided which desk would refuse: that call was made,
      // it answered, and it is billed like any other. So this step reports
      // `routingMicros` and not zero, and `test/driver.test.ts` reads the figure
      // back off the front_desk row rather than recomputing it.
      return {
        kind: 'fail',
        reason: 'refused',
        text: 'I cannot help with that request. If you tell me what trip you are trying to '
            + 'plan, I will pick it up from there.',
        costMicros: routingMicros,
        alreadyRecorded: true,
      }
    }

    // ---- 3. No tool: her answer --------------------------------------------
    const blockIndex = result.content.findIndex((b) => b.type === 'tool_use')
    const toolUse = blockIndex === -1 ? undefined : result.content[blockIndex]
    if (toolUse === undefined || toolUse.type !== 'tool_use') {
      const text = textOfBlocks(result.content).trim()
      return {
        kind: 'message',
        // A `max_tokens` stop can leave the content empty. She gets words either
        // way: a blank agent message is the failure the refusal branch exists to
        // prevent, and reintroducing it here would be absurd.
        text: text.length > 0
          ? text
          : 'I ran out of room mid-thought. Ask me again and I will keep it shorter.',
        // This call plus the routing call that sent it here. `routingMicros` is
        // 0n on every step but the first, where `selectDesk` read the column
        // instead of asking again.
        costMicros: actual + routingMicros,
        alreadyRecorded: true,
      }
    }

    /**
     * The assistant turn as it goes back into the transcript: everything the
     * model said, MINUS any sibling `tool_use` block.
     *
     * Parallel tool use is on by default and `buildRequest` sends no
     * `tool_choice`, so one response can legitimately carry two `tool_use`
     * blocks. An `AgentStep` answers exactly one of them and `loop()` appends
     * this content followed by a single `tool_result`, so echoing both would put
     * an unanswered `tool_use` into the next request, which is a 400 and a dead
     * turn rather than a degraded answer. Dropping the sibling costs the model
     * one round trip to ask for it again; keeping it costs the whole turn.
     *
     * Thinking blocks are untouched, because extended thinking has to be echoed
     * back byte for byte or it is rejected.
     */
    const assistantContent: ContentBlock[] =
      result.content.filter((b) => b.type !== 'tool_use' || b.id === toolUse.id)

    /**
     * The LEDGER's key: position, not `toolUse.id`, which is `toolLoop`'s own
     * scheme (`s${steps}-b${index}`, src/loop.ts) and stable for the same
     * reason here.
     *
     * A persisted transcript makes the REQUEST identical across a resume. It
     * does not make the RESPONSE identical: a provider mints a fresh `toolu_`
     * id every time it answers, and this driver never reads a call id back out
     * of `course.turns.state`, which is input only. So an id taken off the reply
     * cannot recognise a call we already made.
     *
     * The window it has to survive is real: `finishToolCall` lands and the
     * process dies before `saveTurnState` (a Netlify background kill, a fence, a
     * pool error). The resumed turn sends the unchanged transcript, the model
     * asks for the same search again, and under a reply id `beginToolCall` would
     * see a call it has never heard of and run the search a second time. Under
     * `search_hotels` that is a wasted fetch; through `cashierRunner` it is a
     * second re-quote and a second booking link for one intent. Worse in the
     * narrower window between begin and finish: the `pending` row under the old
     * id is orphaned and the ambiguous detection, which exists to catch exactly
     * "started and never finished", is bypassed by a call arriving under a
     * different key.
     *
     * `state.step` is the counter the harness persists with the transcript and
     * increments once per tool step (src/worker.ts), so a re-ask asks at the
     * same position and gets the same id. `beginToolCall`'s own name check
     * catches a resume that asks for a DIFFERENT tool at this position rather
     * than replaying the other call's result.
     */
    const callId = `s${ctx.state.step}-b${blockIndex}`

    // `assistantContent` is computed above and is the same on every branch
    // below: the model asked for this call either way, and the transcript has to
    // carry the ask before it carries the answer or the next request is a 400.
    const step = {
      kind: 'tool' as const,
      /**
       * The PROVIDER's id here, and the positional one above, because the two
       * ids answer two different questions and `toolLoop` already separates
       * them exactly this way (src/loop.ts: the ledger takes the position, the
       * `tool_result` block takes `block.id`). The harness pairs the
       * `tool_result` it appends with this, and it has to be the id the
       * assistant block beside it carries or the next request is a 400. The
       * ledger never sees it.
       */
      callId: toolUse.id,
      name: toolUse.name,
      assistantContent,
      costMicros: actual + routingMicros,
      alreadyRecorded: true,
    }

    if (toolUse.name === 'ask_user') {
      /**
       * The one tool the chain never answers, so the one input `doorRunner`
       * never sees: this branch returns before `deps.run` is called. The
       * allowlist and the schema therefore have to run HERE, or `ask_user` is
       * the single published tool whose input reaches something durable
       * unchecked, which is the contract this lesson is named after.
       *
       * What was unchecked: `questions.join('\n\n')` on an array of objects is
       * the string "[object Object]", and this branch's reply is written to
       * `course.messages` by `completeTurn`, which is her thread. `AskUser`
       * (src/tools/registry.ts) caps it at three questions of 300 characters and
       * requires strings, and none of that was enforced on the one path that
       * writes to her.
       */
      const check = validateToolCall('planning', 'ask_user', toolUse.input)
      if (check.ok) {
        // Terminal by construction: the answer comes from her, not from a tool.
        // It is a `message` step rather than a new kind of step, because a
        // question to her IS the turn's reply: `completeTurn` writes it to
        // course.messages and parks the conversation on `awaiting_user`, which
        // is what a parked turn already meant. No fail reason is added for it,
        // because nothing failed.
        const { questions } = check.input as { questions: string[] }
        return {
          kind: 'message', text: questions.join('\n\n'),
          costMicros: actual + routingMicros, alreadyRecorded: true,
        }
      }
      // The same shape as the budget refusal below, and for the same reason: a
      // sentence the model can correct itself from in the step it has left,
      // rather than a fail reason for something nothing failed at.
      return { ...step, run: async () => ({ content: check.content, isError: true }) }
    }

    /**
     * What this call will cost the supplier budget, from its own input, and
     * zero for the tools that reach no supplier at all.
     *
     * Priced rather than switched on `def.door === 'api'`, which is what this
     * check read until this round. `research_destination` stands behind a
     * `worker` door and searches the hotel supplier once per city on its way to
     * the scouts (`cityPayload`, src/tools.ts), so a door check let three
     * metered searches through a cap that reported none used. The price comes
     * from `SUPPLIER_CALL_COST` (src/tools/supplierBudget.ts), which is the one
     * place a tool is declared to reach a supplier.
     *
     * Read here rather than inside the runner for the same reason the door check
     * was here: the refusal below has to happen BEFORE `ledgerRunner` writes a
     * row, or the refusal counts itself against the next step's budget.
     */
    const cost = supplierCallCost(toolUse.name, toolUse.input)
    if (cost > 0) {
      const budget = await assertSupplierBudget(
        sql, ctx.turnId, limits.maxSupplierCallsPerTurn, cost)
      if (!budget.ok) {
        /**
         * A refusal the model can act on, and one that leaves NO trace in
         * `course.tool_calls`.
         *
         * This `run` never calls `deps.run`, so the chain, and with it
         * `ledgerRunner`, the only writer of that table (src/tools.ts), is
         * bypassed: no `pending` row, no `done` row, nothing durable at all. The
         * refusal lives for exactly one step, as the `tool_result` block the
         * harness appends to the transcript, and dies with the turn.
         *
         * That is the right behaviour rather than an oversight. A row here would
         * be counted by `countSupplierCalls` on the very next step, so a refused
         * search would consume the quota it was refused for, and SPEC section 8
         * says a refusal does not consume quota. What it costs is a real and
         * small thing an operator should know: `select * from course.tool_calls
         * where turn_id = ...` shows the searches that RAN and not the ones this
         * turn was refused, so a turn that asked ten times and was refused four
         * reads there as six.
         *
         * Deliberately still a tool step and not a `fail`: an unmet supplier
         * budget is not a fail reason, and the model has steps left in which to
         * propose from what it already has.
         */
        const wanted = budget.cost === 1 ? '1 supplier search' : `${budget.cost} supplier searches`
        return {
          ...step,
          run: async () => ({
            content: `This call needs ${wanted} and this turn has `
              + `${Math.max(0, budget.max - budget.used)} of its ${budget.max} left. `
              + 'No more searches will run. Propose from what you already have, or ask her a '
              + 'question.',
            isError: true,
          }),
        }
      }
    }

    return { ...step, run: (signal) => deps.run(toolUse.name, toolUse.input, callId, signal) }
  }
}

/**
 * The sentence a capped turn ends on, and the two costs that reach it.
 *
 * One function because the ceiling is now checked in two places, before the
 * routing call and before the driver's own, and two copies of a sentence a
 * traveller reads is one copy that gets edited.
 */
function limitReachedStep(
  reached: 'account' | 'conversation' | 'daily', costMicros: bigint,
): AgentStep {
  return {
    kind: 'fail',
    reason: 'limit_reached',
    // Which ceiling fired changes what she can do about it, so the two are not
    // one sentence: a capped conversation is fixed by starting another one, and
    // a capped day is not.
    text: reached === 'conversation'
      ? 'This conversation has reached its spending limit, so I have stopped here rather '
        + 'than run up more. Start a new conversation and I will pick up from what we agreed.'
      : "We have reached today's spending limit, so I have stopped here rather than run "
        + "up more. Come back tomorrow and I will pick up from what we agreed.",
    costMicros,
    alreadyRecorded: true,
  }
}

/** Which desk answers this turn, or the ceiling the routing call's own reservation crossed. */
export type DeskChoice =
  | { kind: 'desk'; desk: Desk; costMicros: bigint }
  | { kind: 'limit'; reached: 'account' | 'conversation' | 'daily' }

/**
 * Which desk this turn is being answered from, decided once per TURN and read
 * back by everything after it.
 *
 * ## Once per turn, and not once per step counter
 *
 * The decision is looked up before anything else happens, from
 * `readDeskDecision` (src/repo/conversations.ts), which answers null when this
 * turn has not taken one. Branching on `ctx.state.step > 0` instead would be
 * wrong in the one window that costs money: `withRetry` (src/retry.ts) wraps the
 * whole agent step, and a resume whose state write was lost comes back on step
 * 0, so a second attempt would classify again, bill a second Haiku call, write a
 * second `front_desk` row and rewrite the column for a decision already taken.
 * The column cannot answer it alone, because `desk` is `not null default
 * 'planning'` and a row nobody has written reads the same as a row that was
 * written planning; the turn's own `front_desk` row is what tells them apart.
 *
 * `costMicros` follows the same rule the fresh decision follows: the routing
 * call belongs to step 0's bill, whether this attempt made it or found it. On
 * every later step it is zero, because `runTurn` adds a step's cost to
 * `turns.spend_usd_micros` once per step and the routing call is one call.
 *
 * Said exactly, because "belongs to step 0's bill" is not the same as "is added
 * once". A retry that comes back on step 0 and FINDS the decision adds the
 * routing cost again, on top of the addition the first attempt already made, so
 * `turns.spend_usd_micros` over-reports by one routing call per such retry. The
 * ceilings do not move with it: the step carries `alreadyRecorded: true`, so
 * `recordSpend` is never reached and `course.conversations` and
 * `course.daily_usage` still hold exactly what `reconcile` settled. Over-report
 * is the safe direction for a reporting column, and it is not free, so
 * README.md owns it and `readDeskDecision` (src/repo/conversations.ts) states
 * it beside the other way this reader can over-report.
 *
 * ## The order of the three writes
 *
 * Reconcile, then `writeDesk`, then the row. The row is what the next attempt
 * reads as "already decided", so it is written last on purpose: a crash between
 * the desk write and the row costs one more classification, while the opposite
 * order would hand the next attempt a decision the column had not been given
 * yet, and it would answer from whatever the default says.
 *
 * ## The money
 *
 * The classification call is charged like any other model call, through the same
 * reserve and reconcile door, so a turn's bill includes the call that decided
 * where it went. It is a cheap-seat call against a one-line prompt, so the
 * reservation is small and the refund is most of it.
 *
 * It also reads the counters `reserve` RETURNED before it dispatches, exactly
 * the way `makeDriver` does one call later. Without that, a conversation one
 * micro under its ceiling passes `decideNext`'s check at the top of `loop()`,
 * reserves past the cap here and buys a model call anyway, so every turn on a
 * capped conversation still costs one call and up to three under `withRetry`.
 *
 * The reservation is refunded when the call comes back with an error BODY, on
 * exactly the terms `makeDriver` refunds its own (`isUnbilled`, src/errors.ts).
 * Without
 * that, a provider outage would strand one Haiku reservation per attempt in
 * course.daily_usage, which `readSpendFailClosed` sums across all users for the
 * global ceiling: the same leak lesson 5.1 closed for the driver's call, one
 * call earlier in the step.
 */
export async function selectDesk(deps: DriverDeps, ctx: AgentContext): Promise<DeskChoice> {
  const decided = await readDeskDecision(deps.sql, ctx.conversationId, ctx.userId, ctx.turnId)
  if (decided !== null) {
    return {
      kind: 'desk',
      desk: decided.desk,
      costMicros: ctx.state.step === 0 ? decided.costMicros : 0n,
    }
  }
  const first = ctx.state.messages[0]
  const text = first ? textOfBlocks(first.content) : ''
  const reserved = estimateMicros(SEATS.front_desk, 200)
  const { conversationMicros, dailyMicros, day } = await reserve(deps.sql, {
    userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved,
  })
  // Guarded for the reason `makeDriver`'s is: this refund runs on the way to a
  // `limit` choice or on the way out with a classified provider error, and a
  // failed write must not replace either of those with a database error.
  const refund = async () => {
    try {
      await reconcile(deps.sql, {
        userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day,
      })
    } catch (refundErr) {
      console.error(
        `selectDesk: the routing refund for turn ${ctx.turnId} failed. `
        + `${reserved} micros stay reserved against this conversation and this day`,
        refundErr,
      )
    }
  }
  // `globalMicros` is zero for the same reason it is zero in `makeDriver`:
  // `reserve` does not touch it, and `decideNext` checked all three before this
  // agent was called, so only 'conversation' or 'daily' can fire here.
  const reached = whichCeiling({ conversationMicros, dailyMicros, globalMicros: 0n }, deps.limits)
  if (reached !== null) {
    await refund()
    return { kind: 'limit', reached }
  }
  let routing
  try {
    routing = await classifyDesk(text, deps.client)
  } catch (err) {
    if (isUnbilled(err)) await refund()
    throw err
  }
  await reconcile(deps.sql, {
    userId: ctx.userId, conversationId: ctx.conversationId,
    reserved, actual: routing.costMicros, day,
  })
  await writeDesk(deps.sql, ctx.conversationId, ctx.userId, routing.desk)
  await pgSink(deps.sql, {
    userId: ctx.userId, conversationId: ctx.conversationId, turnId: ctx.turnId,
  })({
    // The routing call's own row, labelled with the seat it was actually made
    // on, and versioned with the hash `classifyDesk` computed over the bytes it
    // sent. A hand-written 'classify' literal here would be the one prompt
    // version on this branch that stops changing when its prompt does.
    seat: 'front_desk', seatConfig: SEATS.front_desk, promptVersion: routing.promptVersion,
    modelRequested: SEATS.front_desk.model, modelReturned: SEATS.front_desk.model,
    usage: routing.usage, costMicros: routing.costMicros, latencyMs: routing.latencyMs,
    // The half of lesson 5.7's capture this call can honestly fill. `front_desk`
    // is always `full` (capturePolicyFor), and what is captured is the text the
    // routing decision was made from, which is what anybody debugging a misroute
    // reads. The other three columns stay null on this row rather than carrying
    // an invention: `classifyDesk` returns a `Routing` (src/classify.ts), so its
    // own system prompt, the response body and the request id never leave that
    // function. Its prompt is versioned on the row already, through
    // `routing.promptVersion`. Giving it the other three means having it hand
    // back a `ModelResult`, which is a change to the one call in this module
    // that a fence cannot cancel either, and both belong to the same later
    // lesson rather than to this one. README.md carries it.
    capturePolicy: 'full',
    userPrompt: text,
    // Haiku takes no thinking setting, and `buildRequest` sends none for a seat
    // with no effort. Null here says that rather than leaving it unsaid.
    thinkingMode: null,
  })
  return { kind: 'desk', desk: routing.desk, costMicros: routing.costMicros }
}

/**
 * Whose word this patch is recording, decided from the transcript at the moment
 * of the call, and never by the model, whose tool schema carries no field for it.
 *
 * ## Why it is not the constant 'user'
 *
 * A constant would leave the whole provenance system with no reachable caller,
 * which is exactly the state lesson 5.1 left it in: `applyRequirementsPatch` is
 * `applyRequirements`'s only production caller, so a hardcoded `'user'` makes
 * src/notebook.ts's relax refusal and its `source !== 'user'` guard dead code,
 * and the module that exists to stop an inferred value relaxing something she
 * said would stop nothing.
 *
 * That is reachable with no adversary at all. A supplier result reaches the
 * model's context fenced but present. The model reads "cheapest is EUR 1,650"
 * against her EUR 1,500 budget, calls `update_requirements` to make its own plan
 * work, and stamped `'user'` both guards pass, the budget is relaxed by a number
 * the MODEL chose, and `constraintsFromNotebook` hands it to the budget gate,
 * which then passes a proposal it was built to reject.
 *
 * ## Why it is not the constant 'inferred' either
 *
 * `'inferred'` trips the relax guard on every constraint field, so once she set
 * a budget she could never raise it again through this desk. The rule would be
 * inverted rather than enforced. Provenance is not a constant.
 *
 * ## What the transcript actually tells us
 *
 * `loop()` seeds a fresh turn from `course.messages` as one user text block, so
 * step 0 of every turn is provably her words alone. A `tool_result` block
 * anywhere in this turn's transcript means something untrusted has already been
 * ingested and the model is no longer transcribing only what she said.
 *
 * The cost to her is nothing she would notice: before any search she may relax
 * anything she likes, after a search a patch may still tighten a value or
 * establish a first one, since the guard only blocks relaxations, and her next
 * message starts a clean transcript.
 */
export function provenanceFor(ctx: AgentContext): Provenance {
  const tainted = ctx.state.messages.some(
    (m) => m.content.some((b) => b.type === 'tool_result'),
  )
  return tainted ? 'inferred' : 'user'
}
