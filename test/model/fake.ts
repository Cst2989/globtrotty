import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { Label } from '../../src/classify.js'
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
 * The front desk's reply, the one `classifyDesk` parses: the structured output
 * a published JSON schema asks for, spelled by hand and not recorded.
 *
 * Hand-written because the recorder cannot produce it. A recorded fixture is a
 * reply the live API actually returned, and the two replies this course needs
 * from the front desk are "a label" and "something the schema cannot read";
 * there is no way to ask an API for the second, and the first would tie every
 * routing test to one afternoon's answer. Both live here instead, beside the
 * other hand-written shapes.
 *
 * It takes a `Label` rather than a string so a test cannot queue a label the
 * schema would reject, which is the one failure this helper exists to make
 * impossible and `test/desk-routing.test.ts` still proves on purpose with
 * `textMessage`.
 */
export function labelMessage(label: Label): Message {
  return textMessage(JSON.stringify({ label }))
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

/**
 * Replies in order, and a function entry throws instead of replying.
 *
 * Past the end of the queue it THROWS, and that is the whole point of the
 * helper. It used to clamp at the last reply and hand it back forever, which
 * meant a call the test never queued was absorbed rather than reported: a case
 * that queued three replies and quietly made a fourth model call still passed,
 * and the reply it read was the previous one repeated. That is how lesson 5.3's
 * routing call went unnoticed in four cases at once, because `selectDesk` ate
 * the reply each of them had queued for the agent and the clamp refilled the
 * queue behind it. An over-consumed queue is a test whose subject changed under
 * it, so it fails here and names the count it was given.
 */
export function fakeClient(replies: (Message | (() => never))[]): ModelClient & { calls: number } {
  let next = 0
  const client = {
    calls: 0,
    async create() {
      client.calls += 1
      const reply = replies[next]
      next += 1
      if (reply === undefined) {
        throw new Error(
          `fakeClient was queued ${replies.length} replies and asked for ${next}. `
          + 'A call this test did not queue was made.',
        )
      }
      if (typeof reply === 'function') return reply()
      return reply
    },
  }
  return client
}
