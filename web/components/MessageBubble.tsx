import { parseAction, describeActionForUi } from '@/src/actions'

export type MessageRole = 'user' | 'agent' | 'action'

export type MessageBubbleProps = {
  role: MessageRole
  content: string
}

/**
 * Renders one `messages` row. `content` is always a plain React text child —
 * never raw-HTML-injecting markup (the sentinel test greps `web/` for that
 * dangerous prop name) — so an agent reply that contains something that
 * LOOKS like markdown or HTML (a supplier snippet, a prompt-injection
 * attempt) renders as literal text via React's own escaping, not as markup.
 *
 * An `action` row is never a traveller's or agent's free text: it is JSON a
 * route handler wrote (`src/actions.ts`'s `ActionPayload`). `parseAction`
 * turns it back into a payload and `describeActionForUi` renders the fixed,
 * ids-free sentence for it — the raw JSON (and any id inside it) never
 * reaches the page.
 */
export function MessageBubble({ role, content }: MessageBubbleProps) {
  if (role === 'action') {
    const action = parseAction(content)
    return (
      <p className="message message-action" data-role="action">
        {action ? describeActionForUi(action) : 'You took an action'}
      </p>
    )
  }

  return (
    <p className="message" data-role={role} style={{ whiteSpace: 'pre-wrap' }}>
      {content}
    </p>
  )
}
