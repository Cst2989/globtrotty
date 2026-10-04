import { parseChoices } from '@/src/results'
import { NEXT_QUESTION_ID } from '@/src/agents/nextSteps'
import { ChoiceCard, ChoiceCardLive } from './ChoiceCard'

export type MessageRole = 'user' | 'agent' | 'action' | 'results' | 'choices'

export type MessageBubbleProps = {
  role: MessageRole
  content: string
  /**
   * Enables the live `ChoiceCard` for a `choices` row (it POSTs through
   * `ChoiceCardLive`, which needs the conversation to target). Omitted, the
   * card still renders — question and buttons — but a click does nothing;
   * whatever mounts this component live is expected to pass it.
   */
  conversationId?: string
  /** Task 10: an optimistic row `ThreadLive` has not yet matched to a server one — renders with `data-pending="true"`. */
  pending?: boolean
}

/**
 * Renders one thread row. `content` is always a plain React text child,
 * never raw-HTML-injecting markup (the sentinel test greps `web/` for that
 * dangerous prop name), so an agent reply that LOOKS like markdown or HTML
 * (a supplier snippet, a prompt-injection attempt) renders as literal text
 * via React's own escaping, not as markup.
 *
 * Layout follows the Claude/ChatGPT convention: her messages sit in a
 * tinted bubble on the right, the desk's replies are plain text on the
 * left, an `action` or `results` row (already turned into its fixed,
 * ids-free UI sentence by `web/data.ts`'s `toThreadView` before it reaches
 * the client) is a small centred note, and a `choices` row — spec §3:
 * "Rendered as buttons in the chat" — renders through `ChoiceCard` instead
 * of plain text; its JSON is safe to parse directly (rendered only as plain
 * React children, never as raw HTML): `src/results.ts`'s own doc comment
 * establishes that it is built entirely from our own masked prose plus
 * ids/enums.
 *
 * A `choices` row whose `questionId` is `'next'` (results UI pass 2, F3) renders as a row of
 * small ghost chips instead of the question card: the office asked nothing, these are the three
 * or four next steps it is offering, and a card with a question heading would claim it is waiting
 * for one of them. Every OTHER `questionId` is a real question and keeps the card.
 */
export function MessageBubble({ role, content, conversationId, pending }: MessageBubbleProps) {
  if (role === 'choices') {
    const parsed = parseChoices(content)
    if (!parsed) {
      // Same "never the raw text" posture as the `action`/`results` fallback
      // below — a malformed `choices` row is a garbled write, never
      // something our own writer produces, and its raw JSON must not leak
      // to the browser as if it were prose.
      return (
        <div className="message-row" data-role="choices">
          <p className="message message-action" data-role="choices">
            A question was recorded
          </p>
        </div>
      )
    }
    const variant = parsed.questionId === NEXT_QUESTION_ID ? 'chips' : 'card'
    return (
      <div className="message-row" data-role="choices" data-variant={variant}>
        {conversationId ? (
          <ChoiceCardLive
            conversationId={conversationId}
            questionId={parsed.questionId}
            question={parsed.question}
            options={parsed.options}
            variant={variant}
          />
        ) : (
          <ChoiceCard question={parsed.question} options={parsed.options} variant={variant} onPick={() => {}} />
        )}
      </div>
    )
  }

  const isMarker = role === 'action' || role === 'results'
  return (
    <div className="message-row" data-role={role} data-pending={pending ? 'true' : undefined}>
      <p className={isMarker ? 'message message-action' : 'message'} data-role={role}>
        {content}
      </p>
    </div>
  )
}
