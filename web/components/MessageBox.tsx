'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export type MessageBoxProps = {
  /** The conversation to post to, or `'new'` for the landing box. */
  conversationId: string
  /**
   * `conversations.status`. Omitted for a brand-new (not-yet-created)
   * conversation, which is always sendable — there is nothing yet to be
   * `working` or `limit_reached`.
   */
  status?: string
}

const SENDABLE_STATUSES = new Set(['active', 'awaiting_user'])

/**
 * Fix round 1 (Important): a pure mapping from the route's HTTP status to
 * what she's told, extracted so it's testable without a fetch mock. 409
 * (`busy`) and 429 (`limit_reached`) both mean the message was still
 * WRITTEN — `submitMessage` (`src/handler.ts`) preserves her words on both
 * paths, only the turn fails to queue — so neither is the generic
 * "could not be sent" failure; saying so would be false and would invite a
 * resend that `submitMessage`'s idempotency key can't dedupe against (a
 * fresh `crypto.randomUUID()` per send, by design) into a second row.
 */
export function messageForStatus(status: number): string {
  if (status === 409) {
    return 'Your message is saved. The desk is still working on the last one — it will be read next.'
  }
  if (status === 429) {
    return "Your message is saved, but today's spending limit is reached; the desk will pick it up tomorrow."
  }
  return 'That message could not be sent. Please try again.'
}

/**
 * Where the landing (`conversationId === 'new'`) box sends her after a
 * response, versus where an existing conversation's box does.
 *
 * Fix round 2 (Task 7 review, item 1): a 429 (`limit_reached`) from the
 * landing box used to fall through to `router.refresh()` on `/c/new` —
 * refreshing the SAME page she is already on, which never shows the
 * conversation `submitMessage` actually created (see `src/handler.ts`'s
 * `submitMessage`: it creates the conversation and writes her message BEFORE
 * the ceiling check can fire, so a capped account still gets a real,
 * addressable conversation id back). A 409 (`busy`) is not handled the same
 * way here: `submitMessage` can only report `busy` against an EXISTING
 * conversation with a turn already in flight, and the landing box always
 * passes `conversationId: null` — there is no prior turn to collide with, so
 * that branch is unreachable from `'new'` and is left to refresh in place.
 *
 * Extracted as a pure function (rather than inlined in `handleSubmit`) so
 * this branching is testable without a fetch mock — see
 * `test/web-render.test.ts`.
 */
export function nextLocation(
  conversationId: string, status: number, body: { conversationId: string },
): { type: 'push'; url: string } | { type: 'refresh' } {
  if (conversationId === 'new' && (status === 200 || status === 429)) {
    return { type: 'push', url: `/c/${body.conversationId}` }
  }
  return { type: 'refresh' }
}

/**
 * Disabled unless the conversation is `active` or `awaiting_user` (or
 * brand-new). Posts `{ text, idempotencyKey }` to
 * `/api/conversations/[id]/messages`; `idempotencyKey` is generated fresh
 * per send with `crypto.randomUUID()`, never reused across submits. On
 * success it lets Realtime (`ThreadLive`) drive the refetch for an existing
 * conversation, and navigates to the newly created one for the landing box —
 * see `nextLocation` above for exactly which statuses navigate versus
 * refresh.
 *
 * Fix round 1 (Minor, backlog for Task 11): a network error AFTER the
 * request actually reached the server — the response never arrives, but the
 * message was written — looks identical here to one that never sent at all,
 * and a resend on retry creates a second conversation (for the `'new'` box)
 * or a second, harmless-but-confusing row (for an existing one). `pending`
 * only guards against a double-click while a request is in flight; it does
 * nothing once that request is already gone. Fixing this properly needs a
 * way to ask "did my last idempotencyKey already land?", which does not
 * exist yet.
 */
export function MessageBox({ conversationId, status }: MessageBoxProps) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const statusAllows = status === undefined || SENDABLE_STATUSES.has(status)
  const disabled = !statusAllows || pending

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || disabled) return

    setPending(true)
    setError(null)

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed, idempotencyKey: crypto.randomUUID() }),
      })

      if (!res.ok) {
        setError(messageForStatus(res.status))
        // 409 (busy) and 429 (limit_reached) both still wrote her message —
        // see messageForStatus's doc comment — so the box clears and she is
        // sent to wherever that message now lives (`nextLocation`).
        if (res.status === 409 || res.status === 429) {
          setText('')
          const body = (await res.json()) as { conversationId: string }
          const location = nextLocation(conversationId, res.status, body)
          if (location.type === 'push') router.push(location.url)
          else router.refresh()
        }
        return
      }

      const body = (await res.json()) as { conversationId: string }
      setText('')
      const location = nextLocation(conversationId, res.status, body)
      if (location.type === 'push') router.push(location.url)
      else router.refresh()
    } catch {
      setError(messageForStatus(0))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="message-box">
      <label htmlFor="message-box-text">Message</label>
      <textarea
        id="message-box-text"
        name="text"
        value={text}
        maxLength={4000}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={disabled || text.trim().length === 0}>
        {pending ? 'Sending…' : 'Send'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}
