import { liveClient, textOf, type ModelClient } from './client.js'
import { costMicros, usageOf, type Usage } from './pricing.js'

export const MODEL = 'claude-opus-5'

export type Answer = { text: string; model: string; usage: Usage; costMicros: bigint }

/**
 * One message in, one reply out. No system prompt, no tools, no memory: the
 * model answers her from what it already knows, which is the problem the
 * next lessons work on.
 */
export async function ask(text: string, client: ModelClient = liveClient()): Promise<Answer> {
  // Opus 5 thinks before it answers by default, and those tokens count
  // against max_tokens at the output rate. A 2,048 budget left 75 characters
  // of reply on our first run, so the ceiling is high enough for both.
  const message = await client.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: text }],
  })
  const usage = usageOf(message)
  return { text: textOf(message), model: message.model, usage, costMicros: costMicros(MODEL, usage) }
}
