import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from '../../src/client.js'

// The installed SDK's Usage carries more required fields than the four we
// price on (src/pricing.ts reads only these); the rest are neutral values a
// hand-written fixture has no opinion about.
const USAGE = {
  input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null,
  cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null,
}

/** A hand-written reply, shaped like the API's, for tests about our code rather than the model's. */
export function textMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5',
    container: null,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    usage: USAGE,
    ...overrides,
  } as Message
}

/**
 * `id` is a parameter because a real provider mints a FRESH `toolu_` id on every
 * response, including the response to a re-ask of the identical transcript. A
 * test about what survives a resume has to be able to say so.
 */
export function toolUseMessage(name: string, input: unknown, id = `toolu_${name}`): Message {
  return textMessage('', {
    content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
    stop_reason: 'tool_use',
  } as Partial<Message>)
}

/** Replies in order; a function entry throws instead of replying. */
export function fakeClient(replies: (Message | (() => never))[]): ModelClient & { calls: number } {
  let next = 0
  const client = {
    calls: 0,
    async create() {
      client.calls += 1
      const reply = replies[Math.min(next, replies.length - 1)]
      next += 1
      if (typeof reply === 'function') return reply()
      if (!reply) throw new Error('fakeClient has no replies')
      return reply
    },
  }
  return client
}
