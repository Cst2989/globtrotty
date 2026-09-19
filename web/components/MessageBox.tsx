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
 * Disabled unless the conversation is `active` or `awaiting_user` (or
 * brand-new). Posts `{ text, idempotencyKey }` to
 * `/api/conversations/[id]/messages`; `idempotencyKey` is generated fresh
 * per send with `crypto.randomUUID()`, never reused across submits. On
 * success it lets Realtime (`ThreadLive`) drive the refetch for an existing
 * conversation, and navigates to the newly created one for the landing box.
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
        setError('That message could not be sent. Please try again.')
        return
      }

      const body = (await res.json()) as { conversationId: string }
      setText('')
      if (conversationId === 'new') {
        router.push(`/c/${body.conversationId}`)
      } else {
        router.refresh()
      }
    } catch {
      setError('That message could not be sent. Please try again.')
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
