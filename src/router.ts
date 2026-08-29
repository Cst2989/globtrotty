import type { Label } from './classify.js'
import type { ModelClient } from './client.js'
import { newConversation, turn } from './conversation.js'
import { loadDesk, type DeskName } from './desks.js'
import type { Outcome, ToolTrace } from './loop.js'
import type { ToolRunner } from './tools.js'

export type Handled = {
  label: Label
  text: string
  costMicros: bigint
  toolTrace: ToolTrace[]
  outcome: Outcome
  steps: number
  desk: DeskName
  promptVersion: string
}

/**
 * A thin wrapper over one `turn` on a fresh, throwaway conversation. Lesson
 * 1.7 moves the real state, the notebook and the reply history, into
 * `Conversation`; a caller that wants more than one turn should hold onto
 * that conversation and call `turn` directly instead of calling `handle`
 * again, which would start over with an empty notebook every time.
 *
 * `turn` does not hand back the raw classifier label, only which desk
 * answered, so `label` here is coarser than it was before this lesson:
 * 'faq' when the front desk answered, 'other' otherwise. Nothing downstream
 * of `handle` needs the finer new_trip/change distinction any more; a
 * caller that does should call `turn` and read the label itself.
 */
export async function handle(
  text: string,
  client: ModelClient,
  run: ToolRunner = async () => ({ content: 'No tools on this path', isError: true }),
): Promise<Handled> {
  const result = await turn(newConversation(), text, client, run)
  return {
    label: result.desk === 'front' ? 'faq' : 'other',
    text: result.text,
    costMicros: result.costMicros,
    toolTrace: result.toolTrace,
    outcome: result.outcome,
    steps: result.steps,
    desk: result.desk,
    promptVersion: loadDesk(result.desk).promptVersion,
  }
}
