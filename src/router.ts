import { classify, type Label } from './classify.js'
import type { ModelClient } from './client.js'
import { loadDesk, renderPrompt, toolsFor, type DeskName } from './desks.js'
import { extract, type Requirements } from './extract.js'
import { toolLoop, type Outcome, type ToolTrace } from './loop.js'
import type { ToolRunner } from './tools.js'

export type Handled = {
  label: Label
  text: string
  costMicros: bigint
  requirements: Requirements | null
  toolTrace: ToolTrace[]
  outcome: Outcome
  steps: number
  desk: DeskName
  promptVersion: string
}

/** Fixed so the same request always resolves the same month or relative date into yyyy-mm-dd. */
const TODAY = '2026-08-29'

/**
 * One handler per label. An "other" we could not classify goes to the
 * planning desk, because that desk can answer everything the front desk can
 * and more. Every label but faq runs extraction first, so the planning desk
 * argues from what she actually wrote instead of guessing it again, then
 * runs the tool loop so its prices come from the supplier, not from memory.
 * faq runs the front desk through the same tool loop with no tools, so a
 * caller on that path can leave `run` out.
 */
export async function handle(
  text: string,
  client: ModelClient,
  run: ToolRunner = async () => ({ content: 'No tools on this path', isError: true }),
): Promise<Handled> {
  const classified = await classify(text, client)
  if (classified.label === 'faq') {
    const desk = loadDesk('front')
    const system = renderPrompt(desk, {})
    const result = await toolLoop({ seat: desk.seat, system, userText: text, tools: toolsFor(desk), run, client })
    return {
      label: 'faq',
      text: result.text,
      costMicros: classified.costMicros + result.costMicros,
      requirements: null,
      toolTrace: result.toolTrace,
      outcome: result.outcome,
      steps: result.steps,
      desk: desk.name,
      promptVersion: desk.promptVersion,
    }
  }
  const extracted = await extract(text, client)
  const desk = loadDesk('planning')
  const system = renderPrompt(desk, {
    today: TODAY,
    requirements: JSON.stringify(extracted.requirements),
    dropped: extracted.dropped.length > 0 ? extracted.dropped.join(', ') : 'none',
  })
  const result = await toolLoop({ seat: desk.seat, system, userText: text, tools: toolsFor(desk), run, client })
  const reply = result.outcome === 'done' ? result.text : `We could not finish planning: ${result.outcome}`
  return {
    label: classified.label,
    text: reply,
    costMicros: classified.costMicros + extracted.costMicros + result.costMicros,
    requirements: extracted.requirements,
    toolTrace: result.toolTrace,
    outcome: result.outcome,
    steps: result.steps,
    desk: desk.name,
    promptVersion: desk.promptVersion,
  }
}
