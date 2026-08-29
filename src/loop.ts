import { APIConnectionError, APIError } from '@anthropic-ai/sdk/core/error'
import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import { textOf, type ModelClient } from './client.js'
import { classifyError, isRefusal, type ClassifiedReason } from './errors.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import { withSeat, type Seat } from './seats.js'
import type { ToolRunner } from './tools.js'

export type ToolTrace = { name: string; input: unknown; content: string; isError: boolean }

export type Outcome = 'done' | 'step_cap' | 'refused' | 'max_tokens' | ClassifiedReason

export const MAX_STEPS = 12

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
  /** A run that asks for its thirteenth tool is circling; twelve is a first guess we will measure. */
  maxSteps?: number
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
  const maxSteps = options.maxSteps ?? MAX_STEPS
  const messages: MessageParam[] = [{ role: 'user', content: options.userText }]
  const toolTrace: ToolTrace[] = []
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let steps = 0

  const finish = (outcome: Outcome, text: string): LoopResult =>
    ({ outcome, text, steps, toolTrace, usage, costMicros: costMicros(options.seat.model, usage) })

  for (;;) {
    if (steps >= maxSteps) return finish('step_cap', '')
    steps += 1

    // Thinking tokens count against max_tokens on the Opus seat, so the
    // ceiling leaves room for the thinking and the answer both (lesson 1.1).
    let message
    try {
      message = await options.client.create(
        withSeat(options.seat, { max_tokens: 8000, system: options.system, messages, tools: options.tools }),
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
