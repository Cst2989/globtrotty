import { ask } from './ask.js'
import { classify, type Label } from './classify.js'
import type { ModelClient } from './client.js'
import { extract, type Requirements } from './extract.js'
import { answerFaq } from './faq.js'
import { SEATS } from './seats.js'

export type Handled = { label: Label; text: string; costMicros: bigint; requirements: Requirements | null }

/**
 * Builds the driver's system prompt out of what extract() read from her
 * message: the requirements as JSON, and the fields checkAgainstMessage
 * dropped as questions the driver still owes her.
 */
function requirementsSystem(requirements: Requirements, dropped: (keyof Requirements)[]): string {
  const questions = dropped.length > 0 ? `Ask her about: ${dropped.join(', ')}.` : 'Every field below came from her message; ask nothing more about them.'
  return `Here is what we read from her message so far, as JSON: ${JSON.stringify(requirements)}. ${questions}`
}

/**
 * One handler per label. An "other" we could not classify goes to the driver,
 * because that seat can answer everything the cheap one can and more. Every
 * label but faq runs extraction first, so the driver argues from what she
 * actually wrote instead of guessing it again.
 */
export async function handle(text: string, client: ModelClient): Promise<Handled> {
  const classified = await classify(text, client)
  if (classified.label === 'faq') {
    const answer = await answerFaq(text, client)
    return { label: 'faq', text: answer.text, costMicros: classified.costMicros + answer.costMicros, requirements: null }
  }
  const extracted = await extract(text, client)
  const system = requirementsSystem(extracted.requirements, extracted.dropped)
  const answer = await ask(text, client, SEATS.driver, system)
  return {
    label: classified.label,
    text: answer.text,
    costMicros: classified.costMicros + extracted.costMicros + answer.costMicros,
    requirements: extracted.requirements,
  }
}
