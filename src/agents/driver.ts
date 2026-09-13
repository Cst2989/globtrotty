import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
import { TODAY } from '../conversation.js'
import { loadDesk, renderPrompt } from '../desks.js'
import { textOfBlocks, whichCeiling, type ContentBlock, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { callModel, estimateInputTokens, type CallArgs, type ModelResult } from '../model/client.js'
import { costMicros } from '../pricing.js'
import type { Provenance } from '../notebook.js'
import { pgSink } from '../repo/model-calls.js'
import { loadNotebook, renderNotebook } from '../repo/notebook.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { SEATS } from '../seats.js'
import type { ToolRunner } from '../tools.js'
import { TOOLS, toolsForDesk } from '../tools/registry.js'
import { assertSupplierBudget } from '../tools/supplierBudget.js'
import { validateToolCall } from '../tools/validate.js'
import type { Agent, AgentContext, AgentStep } from '../worker.js'

export type DriverDeps = {
  sql: postgres.Sql
  client: ModelClient
  /**
   * The runner chain, built by whoever constructs the driver, so the driver
   * knows nothing about the ledger, the corpus, the gates or the cashier. Tier 3
   * hands it all five wrappers; a test hands it `mockRunner()`.
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
 * The planning desk, always, in this lesson. `classify` and the front desk leave
 * the deployed path here and come back at lesson 5.3, which is the lesson that
 * owns desk selection and has a column to persist it in. LESSONS.md carries the
 * hand-off, and README.md says plainly what it costs in between: an FAQ reaches
 * the Opus seat.
 */
export function makeDriver(deps: DriverDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql, limits } = deps
    const seat = SEATS.driver
    const desk = loadDesk('planning')

    const notebook = await loadNotebook(sql, ctx.conversationId, ctx.userId)
    const args: CallArgs = {
      seat,
      // Only {{today}} now. The notebook used to be rendered into
      // {{requirements}} and {{dropped}} inside the system prompt, which is the
      // stable prefix lesson 5.6 caches, so every fact she stated would have
      // thrown that prefix away. It rides in the suffix instead.
      system: renderPrompt(desk, { today: TODAY }),
      messages: ctx.state.messages,
      tools: toolsForDesk('planning'),
      // The notebook is volatile: it changes the moment she states a fact. The
      // suffix lands after the last block of the transcript, and from lesson 5.6
      // after the last cache breakpoint, so it never invalidates the cached
      // prefix behind it.
      suffix: renderNotebook(notebook),
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
    const refund = () => reconcile(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day,
    })

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
      return {
        kind: 'fail',
        reason: 'limit_reached',
        // Which ceiling fired changes what she can do about it, so the two are
        // not one sentence: a capped conversation is fixed by starting another
        // one, and a capped day is not.
        text: reached === 'conversation'
          ? 'This conversation has reached its spending limit, so I have stopped here rather '
            + 'than run up more. Start a new conversation and I will pick up from what we agreed.'
          : "We have reached today's spending limit, so I have stopped here rather than run "
            + "up more. Come back tomorrow and I will pick up from what we agreed.",
        costMicros: 0n,
        alreadyRecorded: true,
      }
    }

    // ---- 2. Call, and classify before touching content ----------------------
    // A throw here leaves the reservation debited unless we can say the call was
    // never billed. An error BODY reaching us, at any status from 400 to 503,
    // carries no usage: the provider answered with a refusal to serve rather
    // than with a generation, so nothing was billed and the whole reservation is
    // refunded. That is both halves of the taxonomy that carry a status,
    // `provider_rejected` (the remaining 4xx) and `provider_down` (408, 409,
    // 429 and every 5xx), and `isUnbilled` below names both. A connection
    // failure, a timeout with no response at all or our own abort keeps the
    // debit, because the provider may have generated and billed a response we
    // never saw.
    //
    // Refunding only one half is not a rounding error. `withRetry`
    // (src/retry.ts) wraps the whole agent step at src/worker.ts, so one step
    // against a 503-ing provider reserves three times, and roughly 400,000
    // stranded micros per attempt land in course.daily_usage.
    // `readSpendFailClosed` sums that column across ALL USERS for the global
    // ceiling (src/limits.ts), so on the order of forty failed steps would cap
    // the whole product for the rest of the UTC day at zero real spend, with no
    // lever short of a manual write. `test/driver.test.ts` drives three failed
    // attempts and holds both counters at zero.
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
    const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage)

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
    // `seat` is the literal 'driver' for exactly as long as the driver has one
    // desk. Lesson 5.3 gives it two and replaces this literal with the seat
    // the desk selected, in the same commit, because a row labelled 'driver'
    // for a Haiku front-desk call would make `group by seat` a lie.
    await pgSink(sql, {
      userId: ctx.userId, conversationId: ctx.conversationId, turnId: ctx.turnId,
    })({
      seat: 'driver', seatConfig: seat, promptVersion: desk.promptVersion,
      modelRequested: seat.model, modelReturned: result.model,
      usage: result.usage, costMicros: actual, latencyMs: result.latencyMs,
    })

    if (result.kind === 'refused') {
      // SPEC section 8: a refusal fails the turn and does not consume quota. The
      // reservation above was reconciled to 0n, so the counter is back where it
      // started, and `alreadyRecorded` says so rather than leaving it to be
      // inferred from a zero.
      return {
        kind: 'fail',
        reason: 'refused',
        text: 'I cannot help with that request. If you tell me what trip you are trying to '
            + 'plan, I will pick it up from there.',
        costMicros: 0n,
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
        costMicros: actual,
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
      costMicros: actual,
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
          costMicros: actual, alreadyRecorded: true,
        }
      }
      // The same shape as the budget refusal below, and for the same reason: a
      // sentence the model can correct itself from in the step it has left,
      // rather than a fail reason for something nothing failed at.
      return { ...step, run: async () => ({ content: check.content, isError: true }) }
    }

    const def = TOOLS[toolUse.name]
    if (def?.door === 'api') {
      const budget = await assertSupplierBudget(sql, ctx.turnId, limits.maxSupplierCallsPerTurn)
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
        return {
          ...step,
          run: async () => ({
            content: `You have used all ${budget.max} supplier searches for this turn `
              + `(${budget.used} so far). No more searches will run. Propose from what you `
              + 'already have, or ask her a question.',
            isError: true,
          }),
        }
      }
    }

    return { ...step, run: (signal) => deps.run(toolUse.name, toolUse.input, callId, signal) }
  }
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

/**
 * Did a response body reach us? An error body carries no `usage`, so nothing was
 * billed and the reservation can be refunded in full. Anything with no body at
 * all, a connection failure, a timeout, our own abort, or an error we cannot
 * name, keeps the debit.
 *
 * Derived from the branch's own classifier rather than from a second list of
 * statuses: `provider_rejected` and `provider_down` are exactly the two reasons
 * `classifyError` (src/errors.ts) produces from an HTTP STATUS, which is to say
 * from a response the provider sent. It rejected the request (400, 401, 403,
 * 404) or it could not serve it (408, 409, 429, 5xx); either way it did not
 * generate tokens, and a 429 in an outage is no more billed than a 400 is.
 *
 * The two that are left out are the two with no response behind them.
 * `fetch_failed` is `APIConnectionError`: the request never reached the
 * provider, or a timeout expired with nothing coming back, and a timeout is the
 * case where a generation may well have been produced and billed after we
 * stopped listening. `unclassified` covers our own abort and anything we cannot
 * name, where we know nothing at all. Both keep the debit, which is the
 * conservative direction on a guardrail.
 */
function isUnbilled(err: unknown): boolean {
  const { reason } = classifyError(err)
  return reason === 'provider_rejected' || reason === 'provider_down'
}
