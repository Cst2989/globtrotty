import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import { textOf, type ModelClient } from './client.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import { withSeat, type Seat } from './seats.js'
import type { ToolRunner } from './tools.js'

export type ToolTrace = { name: string; input: unknown; content: string; isError: boolean }

export type LoopResult = {
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
}

function addUsage(a: Usage, b: Usage): Usage {
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
 * asking. Nothing bounds it yet; lesson 1.5 adds that.
 */
export async function toolLoop(options: LoopOptions): Promise<LoopResult> {
  const messages: MessageParam[] = [{ role: 'user', content: options.userText }]
  const toolTrace: ToolTrace[] = []
  let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let steps = 0
  for (;;) {
    steps += 1
    // Thinking tokens count against max_tokens on the Opus seat, so the
    // ceiling leaves room for the thinking and the answer both (lesson 1.1).
    const message = await options.client.create(
      withSeat(options.seat, { max_tokens: 8000, system: options.system, messages, tools: options.tools }),
    )
    usage = addUsage(usage, usageOf(message))
    if (message.stop_reason !== 'tool_use') {
      return { text: textOf(message), steps, toolTrace, usage, costMicros: costMicros(options.seat.model, usage) }
    }
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
