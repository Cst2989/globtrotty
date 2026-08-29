import { classify, type Label } from './classify.js'
import type { ModelClient } from './client.js'
import { extract, type Requirements } from './extract.js'
import { answerFaq } from './faq.js'
import { toolLoop, type Outcome, type ToolTrace } from './loop.js'
import { SEATS } from './seats.js'
import { TOOLS, type ToolRunner } from './tools.js'

export type Handled = {
  label: Label
  text: string
  costMicros: bigint
  requirements: Requirements | null
  toolTrace: ToolTrace[]
  outcome: Outcome
  steps: number
}

/**
 * Builds the driver's planning system prompt out of what extract() read from
 * her message: the requirements as JSON, the fields checkAgainstMessage
 * dropped as questions the driver still owes her, today's date fixed so the
 * same request always resolves to the same yyyy-mm-dd searches, and the
 * instruction that keeps the driver from quoting anything it did not
 * actually search for.
 */
function planningSystem(requirements: Requirements, dropped: (keyof Requirements)[]): string {
  const questions = dropped.length > 0 ? `Ask her about: ${dropped.join(', ')}.` : 'Every field below came from her message; ask nothing more about them.'
  return [
    `Here is what we read from her message so far, as JSON: ${JSON.stringify(requirements)}.`,
    questions,
    "Treat today's date as 2026-08-29 when you resolve a month or a relative date into yyyy-mm-dd, so the same request always searches the same dates.",
    'Search for flights and hotels before you quote any price. List each offer with the price the supplier quoted; do not add prices together or invent a total, and never quote a number no search returned.',
  ].join(' ')
}

/**
 * One handler per label. An "other" we could not classify goes to the
 * driver, because that seat can answer everything the cheap one can and
 * more. Every label but faq runs extraction first, so the driver argues from
 * what she actually wrote instead of guessing it again, then runs the tool
 * loop so its prices come from the supplier, not from memory. faq needs no
 * tools, so callers on that path can leave `run` out.
 */
export async function handle(
  text: string,
  client: ModelClient,
  run: ToolRunner = async () => ({ content: 'No tools on this path', isError: true }),
): Promise<Handled> {
  const classified = await classify(text, client)
  if (classified.label === 'faq') {
    const answer = await answerFaq(text, client)
    return {
      label: 'faq', text: answer.text, costMicros: classified.costMicros + answer.costMicros,
      requirements: null, toolTrace: [], outcome: 'done', steps: 0,
    }
  }
  const extracted = await extract(text, client)
  const system = planningSystem(extracted.requirements, extracted.dropped)
  const result = await toolLoop({ seat: SEATS.driver, system, userText: text, tools: TOOLS, run, client })
  const reply = result.outcome === 'done' ? result.text : `We could not finish planning: ${result.outcome}`
  return {
    label: classified.label,
    text: reply,
    costMicros: classified.costMicros + extracted.costMicros + result.costMicros,
    requirements: extracted.requirements,
    toolTrace: result.toolTrace,
    outcome: result.outcome,
    steps: result.steps,
  }
}
