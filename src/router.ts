import { ask } from './ask.js'
import { classify, type Label } from './classify.js'
import type { ModelClient } from './client.js'
import { answerFaq } from './faq.js'
import { SEATS } from './seats.js'

export type Handled = { label: Label; text: string; costMicros: bigint }

/**
 * One handler per label. An "other" we could not classify goes to the driver,
 * because that seat can answer everything the cheap one can and more.
 */
export async function handle(text: string, client: ModelClient): Promise<Handled> {
  const classified = await classify(text, client)
  if (classified.label === 'faq') {
    const answer = await answerFaq(text, client)
    return { label: 'faq', text: answer.text, costMicros: classified.costMicros + answer.costMicros }
  }
  const answer = await ask(text, client, SEATS.driver)
  return { label: classified.label, text: answer.text, costMicros: classified.costMicros + answer.costMicros }
}
