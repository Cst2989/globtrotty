import type postgres from 'postgres'
import type { ModelClient } from '../client.js'
import { TODAY } from '../conversation.js'
import { loadDesk, renderPrompt, toolsFor } from '../desks.js'
import { textOfBlocks, whichCeiling, type ContentBlock, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { callModel, estimateInputTokens, type CallArgs, type ModelResult } from '../model/client.js'
import { costMicros } from '../pricing.js'
import { pgSink } from '../repo/model-calls.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { SEATS } from '../seats.js'
import type { ToolRunner } from '../tools.js'
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

    const args: CallArgs = {
      seat,
      system: renderPrompt(desk, {
        today: TODAY,
        requirements: 'nothing yet',
        dropped: 'none',
      }),
      messages: ctx.state.messages,
      tools: toolsFor(desk) as unknown[],
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
    // carries no usage, so nothing was billed and the whole reservation is
    // refunded. A connection failure, a timeout or our own abort keeps the
    // debit, because the provider may have generated and billed a response we
    // never saw.
    //
    // Getting this wrong in the other direction is not a rounding error. An
    // outage produces 429s and 5xx, roughly 400,000 stranded micros per attempt
    // land in course.daily_usage, and readSpendFailClosed sums that column
    // across ALL USERS for the global ceiling, so a few hundred failed calls
    // would cap the whole product for the rest of the UTC day at zero real
    // spend, with no lever short of a manual write.
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
    const toolUse = result.content.find((b) => b.type === 'tool_use')
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

    return {
      kind: 'tool',
      /**
       * The PROVIDER's id, which is correct from this lesson and was not before
       * it. `toolLoop` keys its calls positionally (`s${steps}-b${index}`)
       * because its transcript died with the call: a resumed turn asked the
       * model the same questions and got fresh `toolu_` ids back, so an id from
       * the reply could not recognise a call we had already made. A transcript
       * held in `course.turns.state` replays the SAME assistant blocks with the
       * SAME id, so the provider's id is stable across a resume and is the right
       * key for `course.tool_calls (turn_id, call_id)`.
       */
      callId: toolUse.id,
      name: toolUse.name,
      run: (signal) => deps.run(toolUse.name, toolUse.input, toolUse.id, signal),
      assistantContent,
      costMicros: actual,
      alreadyRecorded: true,
    }
  }
}

/**
 * Did a response body reach us? An error body carries no `usage`, so nothing was
 * billed and the reservation can be refunded in full. Anything with no body at
 * all, a connection failure, a timeout, our own abort, or an error we cannot
 * name, keeps the debit.
 *
 * Derived from the branch's own classifier rather than from a second list of
 * statuses: `provider_rejected` is the bucket for a provider that looked at this
 * request and said no, which is exactly the case where a body came back.
 */
function isUnbilled(err: unknown): boolean {
  return classifyError(err).reason === 'provider_rejected'
}
