import { APIConnectionError, APIError } from '@anthropic-ai/sdk/core/error'
import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import { textOf, type ModelClient } from './client.js'
import { classifyError, isRefusal } from './errors.js'
import { decideNext, type Limits, type Spend } from './engine.js'
import type { FailReason } from './engine.js'
import { callAndRecord } from './metered.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
import { withSeat, type Seat } from './seats.js'
import type { ToolRunner } from './tools.js'

export type ToolTrace = { name: string; input: unknown; content: string; isError: boolean }

/**
 * A turn ends in exactly one of these. Everything but `done`, `max_tokens` and
 * `continue_later` is a `FailReason`, which is the same list lesson 2.7 writes
 * into the database constraint.
 */
export type Outcome = 'done' | 'max_tokens' | 'continue_later' | FailReason

/** A run that asks for its thirteenth tool is circling. Twelve is what lesson 1.5 measured. */
export const MAX_STEPS = 12

/**
 * Nothing meters spend yet, so the loop is handed zeroes and ceilings it cannot
 * reach. Lesson 2.6 deletes both of these and hands it the real ledger.
 */
export const NO_SPEND: Spend = { conversationMicros: 0n, dailyMicros: 0n, globalMicros: 0n }
export const UNMETERED_LIMITS: Limits = {
  conversationCeilingMicros: 2n ** 62n,
  dailyCeilingMicros: 2n ** 62n,
  globalCeilingMicros: 2n ** 62n,
  maxSteps: MAX_STEPS,
}

export type LoopResult = {
  outcome: Outcome
  text: string
  steps: number
  toolTrace: ToolTrace[]
  usage: Usage
  costMicros: bigint
}

export type LoopOptions = {
  seat: Seat
  system: string
  userText: string
  tools: Tool[]
  run: ToolRunner
  client: ModelClient
  /** The ceilings this run answers to. */
  limits?: Limits
  /** What has been spent so far, as the caller last read it. */
  spend?: Spend
  /** The clock, handed in rather than read, so the engine stays pure. */
  now?: () => number
  /** When the process that runs this loop expects to be killed. */
  deadlineMs?: number
  /** How long one step is assumed to take, so we stop before we are cut off. */
  estStepMs?: number
  /** Which prompt this run used, so a row can be attributed to it. */
  promptVersion?: string
  /**
   * Where this run's model calls get written. Omitted, nothing is recorded and
   * nothing fails: a call site that forgets this loses its rows silently
   * rather than throwing, which is why every call site that should record is
   * checked by a test rather than by a type.
   */
  record?: ModelCallSink
}

/** Token-by-token sum, with no opinion on whether `a` and `b` came from the same model. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  }
}

/**
 * The model asks for a tool, we run it, the result goes back in the next user
 * turn, and the model chooses again. The loop ends when the model stops
 * asking, when it hits the step cap, when it refuses, or when the provider
 * itself fails; every ending is a `LoopResult` with an `outcome`, never a
 * thrown exception (lesson 1.5).
 */
export async function toolLoop(options: LoopOptions): Promise<LoopResult> {
  const messages: MessageParam[] = [{ role: 'user', content: options.userText }]
  const toolTrace: ToolTrace[] = []
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let steps = 0

  const limits = options.limits ?? UNMETERED_LIMITS
  const now = options.now ?? Date.now
  // A run with no deadline of its own is given one an hour away, which is longer
  // than any tier that hosts it; tier 3 passes its real fifteen minute budget.
  const deadlineMs = options.deadlineMs ?? now() + 60 * 60_000
  const estStepMs = options.estStepMs ?? 20_000

  const finish = (outcome: Outcome, text: string): LoopResult =>
    ({ outcome, text, steps, toolTrace, usage, costMicros: costMicros(options.seat.model, usage) })

  for (;;) {
    const decision = decideNext({
      state: { step: steps },
      spend: options.spend ?? NO_SPEND,
      limits,
      nowMs: now(),
      deadlineMs,
      estStepMs,
      pendingUserMessage: null,
    })
    if (decision.kind === 'stop') return finish(decision.reason, '')
    // Nowhere to continue to inside one process. Module 3 saves the state here
    // and lets a fresh invocation pick the turn up.
    if (decision.kind === 'continue_later') return finish('continue_later', '')
    // Not reachable yet: nothing returns 'park' until a desk can ask her a
    // question and wait. The branch exists so a new decision kind cannot be
    // silently ignored here.
    if (decision.kind === 'park') return finish('done', decision.message)
    steps += 1

    // Thinking tokens count against max_tokens on the Opus seat, so the
    // ceiling leaves room for the thinking and the answer both (lesson 1.1).
    let message
    try {
      message = await callAndRecord(
        options.client,
        withSeat(options.seat, { max_tokens: 8000, system: options.system, messages, tools: options.tools }),
        {
          seat: options.seat,
          // 'unversioned' means a caller forgot to pass one, not that the
          // prompt has no version: every desk and every prompt in this
          // codebase computes one from its own text, so a row that carries
          // this string names a call site to go fix, not a fact about a call.
          promptVersion: options.promptVersion ?? 'unversioned',
          record: options.record,
        },
      )
    } catch (err) {
      // classifyError's `unclassified` bucket is meant for a provider error we
      // do not yet have a rule for, not for a crash in our own code: a plain
      // Error thrown by our client (the process died, a bug threw) is not a
      // provider failure and must not be swallowed into an outcome. Only an
      // error the SDK itself raises (APIError, which APIConnectionError also
      // extends) belongs to this catch; anything else propagates.
      if (!(err instanceof APIError) && !(err instanceof APIConnectionError)) throw err
      return finish(classifyError(err).reason, '')
    }
    usage = addUsage(usage, usageOf(message))

    if (isRefusal(message)) return finish('refused', textOf(message))
    if (message.stop_reason === 'max_tokens') return finish('max_tokens', textOf(message))
    if (message.stop_reason !== 'tool_use') return finish('done', textOf(message))

    messages.push({ role: 'assistant', content: message.content })
    const results: ContentBlockParam[] = []
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const outcome = await options.run(block.name, block.input)
      toolTrace.push({ name: block.name, input: block.input, ...outcome })
      results.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.content, is_error: outcome.isError })
    }
    messages.push({ role: 'user', content: results })
  }
}
