export type MessageRole = 'user' | 'agent' | 'action'

export type MessageBubbleProps = {
  role: MessageRole
  content: string
}

/**
 * Renders one thread row. `content` is always a plain React text child —
 * never raw-HTML-injecting markup (the sentinel test greps `web/` for that
 * dangerous prop name) — so an agent reply that contains something that
 * LOOKS like markdown or HTML (a supplier snippet, a prompt-injection
 * attempt) renders as literal text via React's own escaping, not as markup.
 *
 * Fix round 1 (Minor): an `action` row's `content` is no longer JSON by the
 * time it reaches this component. `web/data.ts`'s `loadThread` (via
 * `toThreadView`) now turns it into its fixed, ids-free UI sentence
 * server-side, before the row ever leaves the server — so the raw JSON a
 * route handler wrote never enters the RSC payload, let alone this render.
 * This component's only remaining job for that role is the `message-action`
 * styling hook.
 */
export function MessageBubble({ role, content }: MessageBubbleProps) {
  return (
    <p
      className={role === 'action' ? 'message message-action' : 'message'}
      data-role={role}
      style={{ whiteSpace: 'pre-wrap' }}
    >
      {content}
    </p>
  )
}
