export type MessageRole = 'user' | 'agent' | 'action'

export type MessageBubbleProps = {
  role: MessageRole
  content: string
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
 * left, and an `action` row (already turned into its fixed, ids-free UI
 * sentence by `web/data.ts`'s `toThreadView` before it reaches the client)
 * is a small centred note.
 */
export function MessageBubble({ role, content }: MessageBubbleProps) {
  return (
    <div className="message-row" data-role={role}>
      <p className={role === 'action' ? 'message message-action' : 'message'} data-role={role}>
        {content}
      </p>
    </div>
  )
}
