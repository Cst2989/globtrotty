import { liveClient, textOf, type ModelClient } from './client.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import { SEATS, withSeat, type Seat } from './seats.js'

export type Answer = { text: string; model: string; usage: Usage; costMicros: bigint }

/**
 * One message in, one reply out. No tools, no memory: the model answers her
 * from what it already knows and, from lesson 1.3 on, from an optional
 * system prompt the router builds out of what extract() read from her
 * message.
 */
export async function ask(text: string, client: ModelClient = liveClient(), seat: Seat = SEATS.driver, system?: string): Promise<Answer> {
  // Opus 5 thinks before it answers by default, and those tokens count
  // against max_tokens at the output rate. A 2,048 budget left 75 characters
  // of reply on our first run, so the ceiling is high enough for both.
  const message = await client.create(
    withSeat(seat, {
      max_tokens: 8000,
      ...(system !== undefined ? { system } : {}),
      messages: [{ role: 'user', content: text }],
    }),
  )
  const usage = usageOf(message)
  // `'5m'` and not `SYSTEM_CACHE_TTL`: lesson 1.1's one-shot demo predates
  // `callAndRecord`, calls `client.create` directly, and puts no `cache_control`
  // anywhere, so it writes no cache at all and `cache_creation_input_tokens`
  // comes back zero. The multiplier is never reached and `'5m'` is the honest
  // argument for what this call actually sent.
  return {
    text: textOf(message), model: message.model, usage,
    costMicros: costMicros(seat.model, usage, '5m'),
  }
}
