import { APIConnectionError, APIError } from '@anthropic-ai/sdk/core/error'
import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import { textOf, type ModelClient } from './client.js'
import { classifyError, isRefusal } from './errors.js'
import { decideNext, type Limits, type Spend } from './engine.js'
import type { FailReason } from './engine.js'
import { DEFAULT_LIMITS } from './limits.js'
import { callAndRecord } from './metered.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
import { limitReachedMessage } from './limit-message.js'
import { SpendUnconfirmedError } from './repo/spend.js'
import { withSeat, type Seat } from './seats.js'
import type { ToolRunner } from './tools.js'

export type ToolTrace = { name: string; input: unknown; content: string; isError: boolean }

/**
 * A turn ends in exactly one of these. Everything but `done`, `max_tokens` and
 * `continue_later` is a `FailReason`, which is the same list lesson 2.7 writes
 * into the database constraint.
 */
export type Outcome = 'done' | 'max_tokens' | 'continue_later' | FailReason

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
  /** Read once per step, so a ceiling check is never stale for the rest of the turn. */
  readSpend?: () => Promise<Spend>
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
 * Runs a caller's `readSpend` and turns its one fail-closed throw into the
 * sentinel `'limit_reached'` instead of letting it escape. Shared by this
 * loop's per-step read below and `turn()`'s top-of-turn read
 * (src/conversation.ts), which is the read that runs before the loop, on
 * classify and extract: two call sites that both must not strand a turn on a
 * read that could not confirm what was spent, described once rather than
 * twice.
 *
 * Only `SpendUnconfirmedError` is caught. Anything else, a `TypeError` in a
 * caller-supplied reader, a bug in `readSpendFailClosed` itself, a
 * connection-pool error that surfaces as something else, is a crash in our
 * own code and not a failed read, and it propagates: this is the same rule
 * the loop's own model-call catch applies to a non-`APIError` below, and a
 * blanket catch here would silently turn a real bug into an empty reply for
 * her instead of a stack trace for whoever is on call.
 */
export async function readSpendOrLimitReached(
  readSpend: () => Promise<Spend>,
): Promise<Spend | 'limit_reached'> {
  try {
    return await readSpend()
  } catch (err) {
    if (!(err instanceof SpendUnconfirmedError)) throw err
    console.error('readSpend failed, denying as a reached ceiling', err)
    return 'limit_reached'
  }
}

/**
 * The model asks for a tool, we run it, the result goes back in the next user
 * turn, and the model chooses again. The loop ends when the model stops
 * asking, when it hits the step cap, when it refuses, or when the provider
 * itself fails; every one of those is a `LoopResult` with an `outcome`, never
 * a thrown exception (lesson 1.5). A read that cannot confirm what has been
 * spent ends the turn the same way (lesson 2.6), but that is the only error
 * class caught for it: a bug in our own code still propagates, because a
 * retry cannot fix a bug and swallowing it would hide one behind an outcome
 * meant for the provider or the ceiling.
 */
export async function toolLoop(options: LoopOptions): Promise<LoopResult> {
  const messages: MessageParam[] = [{ role: 'user', content: options.userText }]
  const toolTrace: ToolTrace[] = []
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let steps = 0

  const limits = options.limits ?? DEFAULT_LIMITS
  const now = options.now ?? Date.now
  // A run with no deadline of its own is given one an hour away, which is longer
  // than any tier that hosts it; tier 3 passes its real fifteen minute budget.
  const deadlineMs = options.deadlineMs ?? now() + 60 * 60_000
  const estStepMs = options.estStepMs ?? 20_000

  const finish = (outcome: Outcome, text: string): LoopResult =>
    ({ outcome, text, steps, toolTrace, usage, costMicros: costMicros(options.seat.model, usage) })

  for (;;) {
    let spend: Spend
    if (options.readSpend) {
      // readSpendFailClosed throws rather than returning a number when it
      // cannot confirm what has been spent (src/repo/spend.ts). That throw
      // must not escape here: this function's whole contract is "never a
      // thrown exception" (see the docstring above), and the caller across
      // the process boundary (run-turn-background.mts) awaits `turn()`
      // inside a try/finally with no catch, so an uncaught throw here would
      // strand the turn at 'queued' instead of finishing it. A read that
      // cannot confirm spend is treated the same as a read that confirms
      // the ceiling is reached: both mean "do not prove it is safe to spend
      // more", which is exactly what a fail-closed guard is for.
      const read = await readSpendOrLimitReached(options.readSpend)
      if (read === 'limit_reached') return finish('limit_reached', limitReachedMessage(read, limits))
      spend = read
    } else {
      spend = { conversationMicros: 0n, dailyMicros: 0n, globalMicros: 0n }
    }
    const decision = decideNext({
      state: { step: steps },
      spend,
      limits,
      nowMs: now(),
      deadlineMs,
      estStepMs,
      pendingUserMessage: null,
    })
    // A capped turn is the one stop reason that reaches her as a real
    // sentence, from src/limit-message.ts, the same one tier 2 writes on its
    // own denial (src/handler.ts) and `finishTurn` records with `fail_reason`
    // set. step_cap and deadline_exceeded have not earned a sentence of their
    // own yet, so they still return empty text, and `finishTurn` now skips
    // the agent row rather than write a blank one.
    if (decision.kind === 'stop') {
      const text = decision.reason === 'limit_reached' ? limitReachedMessage(spend, limits) : ''
      return finish(decision.reason, text)
    }
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
