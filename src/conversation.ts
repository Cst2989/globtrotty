import type { ModelClient } from './client.js'
import { loadDesk, renderPrompt, toolsFor } from './desks.js'
import { classify } from './classify.js'
import { extract } from './extract.js'
import { addUsage, toolLoop, type LoopResult } from './loop.js'
import { applyRequirements, emptyNotebook, notebookForPrompt, type Notebook } from './notebook.js'
import type { ToolRunner } from './tools.js'

export type Conversation = {
  id: string
  notebook: Notebook
  /** Every reply we sent her, in order; the only record of the conversation there is. */
  replies: string[]
}

export const TODAY = '2026-08-29'

export function newConversation(id = 'conv-1'): Conversation {
  return { id, notebook: emptyNotebook(), replies: [] }
}

export type TurnResult = LoopResult & { conversation: Conversation; desk: 'front' | 'planning' }

/**
 * One message from her, one reply from us. Extraction writes her words into
 * the notebook before the desk reads it, so the desk plans from what she
 * said across every turn and not only this one. `costMicros` is the sum of
 * every model call this turn made, classify and (on the planning path)
 * extract included, because a bill that only counted the loop would be one
 * she never actually paid.
 */
export async function turn(conversation: Conversation, text: string, client: ModelClient, run: ToolRunner): Promise<TurnResult> {
  const classified = await classify(text, client)
  if (classified.label === 'faq') {
    const desk = loadDesk('front')
    const result = await toolLoop({ seat: desk.seat, system: renderPrompt(desk, {}), userText: text, tools: toolsFor(desk), run, client })
    const next = { ...conversation, replies: [...conversation.replies, result.text] }
    return {
      ...result,
      usage: addUsage(result.usage, classified.usage),
      costMicros: result.costMicros + classified.costMicros,
      conversation: next,
      desk: 'front',
    }
  }
  const extracted = await extract(text, client)
  const patch = Object.fromEntries(Object.entries(extracted.requirements).filter(([, v]) => v !== null))
  const notebook = applyRequirements(conversation.notebook, patch, 'user', new Date().toISOString())
  const desk = loadDesk('planning')
  const system = renderPrompt(desk, {
    today: TODAY,
    requirements: notebookForPrompt(notebook),
    dropped: extracted.dropped.length ? extracted.dropped.join(', ') : 'none',
  })
  const result = await toolLoop({ seat: desk.seat, system, userText: text, tools: toolsFor(desk), run, client })
  const next = { ...conversation, notebook, replies: [...conversation.replies, result.text] }
  return {
    ...result,
    usage: addUsage(addUsage(result.usage, classified.usage), extracted.usage),
    costMicros: result.costMicros + classified.costMicros + extracted.costMicros,
    conversation: next,
    desk: 'planning',
  }
}
