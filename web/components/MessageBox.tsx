'use client'

import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUp } from '@phosphor-icons/react'

export type MessageBoxProps = {
  /** The conversation to post to, or `'new'` for the landing box. */
  conversationId: string
  /**
   * `conversations.status`. Omitted for a brand-new (not-yet-created)
   * conversation, which is always sendable: there is nothing yet to be
   * `working` or `limit_reached`.
   */
  status?: string
  /** Prompt chips shown above the box on the landing page; a tap fills the box. */
  suggestions?: string[]
  /** Overrides the default placeholder. */
  placeholder?: string
}

const SENDABLE_STATUSES = new Set(['active', 'awaiting_user'])

/**
 * A pure mapping from the route's HTTP status to what she's told, extracted
 * so it's testable without a fetch mock. 409 (`busy`) and 429
 * (`limit_reached`) both mean the message was still WRITTEN;
 * `submitMessage` (`src/handler.ts`) preserves her words on both paths, only
 * the turn fails to queue. So neither is the generic "could not be sent"
 * failure; saying so would be false and would invite a resend that
 * `submitMessage`'s idempotency key can't dedupe against (a fresh
 * `crypto.randomUUID()` per send, by design) into a second row.
 */
export function messageForStatus(status: number): string {
  if (status === 409) {
    return 'Your message is saved. The desk is still working on the last one; yours is read next.'
  }
  if (status === 429) {
    return "Your message is saved, but today's spending limit is reached. The desk will pick it up tomorrow."
  }
  return 'That message could not be sent. Please try again.'
}

/**
 * Where the landing (`conversationId === 'new'`) box sends her after a
 * response, versus where an existing conversation's box does.
 *
 * A 429 (`limit_reached`) from the landing box navigates to the conversation
 * `submitMessage` actually created (it creates the conversation and writes
 * her message BEFORE the ceiling check can fire, so a capped account still
 * gets a real, addressable conversation id back). A 409 (`busy`) is
 * unreachable from `'new'` (no prior turn to collide with) and is left to
 * refresh in place. Pure so `test/web-render.test.ts` can pin it.
 */
export function nextLocation(
  conversationId: string, status: number, body: { conversationId: string },
): { type: 'push'; url: string } | { type: 'refresh' } {
  if (conversationId === 'new' && (status === 200 || status === 429)) {
    return { type: 'push', url: `/c/${body.conversationId}` }
  }
  return { type: 'refresh' }
}

/** What the disabled composer says instead of its placeholder. */
function blockedPlaceholder(status: string | undefined): string | null {
  if (status === 'working') return 'The desk is working on your last message'
  if (status === 'limit_reached') return "Today's limit is reached. Back tomorrow."
  if (status === 'escalated') return 'A person from the office has this conversation'
  if (status === 'failed') return 'Send a message to try again'
  if (status === 'archived') return 'This trip is archived'
  return null
}

/**
 * The composer. Disabled unless the conversation is `active` or
 * `awaiting_user` (or brand-new). Enter sends, Shift+Enter adds a line, like
 * every chat client. Posts `{ text, idempotencyKey }` to
 * `/api/conversations/[id]/messages`; `idempotencyKey` is generated fresh
 * per send with `crypto.randomUUID()`, never reused across submits. On
 * success it lets Realtime (`ThreadLive`) drive the refetch for an existing
 * conversation, and navigates to the newly created one for the landing box
 * (see `nextLocation`).
 *
 * Known gap (backlog 4a): a network error AFTER the request reached the
 * server looks identical to one that never sent, and a retry can create a
 * second row. `pending` only guards a double-click while a request is in
 * flight.
 */
export function MessageBox({ conversationId, status, suggestions, placeholder }: MessageBoxProps) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const statusAllows = status === undefined || SENDABLE_STATUSES.has(status)
  const disabled = !statusAllows || pending
  const canSend = !disabled && text.trim().length > 0

  async function send() {
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
        // 409 and 429 both still wrote her message (see messageForStatus),
        // so the box clears and she is sent to wherever that message lives.
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const effectivePlaceholder = blockedPlaceholder(status) ?? placeholder ?? 'Message the travel desk'

  return (
    <form onSubmit={handleSubmit} className="message-box">
      {suggestions && suggestions.length > 0 ? (
        <div className="suggestions" aria-label="Ideas to start with">
          {suggestions.map((s) => (
            <button key={s} type="button" className="suggestion" onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <label htmlFor="message-box-text" className="visually-hidden">
          Message
        </label>
        <textarea
          id="message-box-text"
          name="text"
          rows={1}
          value={text}
          maxLength={4000}
          disabled={disabled}
          placeholder={effectivePlaceholder}
          onChange={(event) => {
            setText(event.target.value)
            // Grow with the content (Safari has no `field-sizing: content` yet).
            event.target.style.height = 'auto'
            event.target.style.height = `${event.target.scrollHeight}px`
          }}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="btn composer-send" disabled={!canSend} aria-label={pending ? 'Sending' : 'Send'}>
          <ArrowUp size={18} weight="bold" aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : (
        <p className="composer-hint">Prices come from live searches. Globetrotty never asks for payment or passport details.</p>
      )}
    </form>
  )
}
