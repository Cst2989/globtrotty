import { textOf, type ModelClient } from './client.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import { SEATS, withSeat } from './seats.js'

const SYSTEM =
  'You answer short factual travel questions for a travel agency in three sentences at most. ' +
  'If the answer depends on nationality or dates, say what it depends on instead of guessing.'

export type FaqAnswer = { text: string; usage: Usage; costMicros: bigint }

export async function answerFaq(text: string, client: ModelClient): Promise<FaqAnswer> {
  const message = await client.create(
    withSeat(SEATS.cheap, { max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: text }] }),
  )
  const usage = usageOf(message)
  return { text: textOf(message), usage, costMicros: costMicros(SEATS.cheap.model, usage) }
}
