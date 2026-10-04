'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useActivity } from './activity'

export type ChoiceCardProps = {
  question: string
  options: { id: string; label: string }[]
  /** Disables every button while a request from the live wrapper is in flight. */
  disabled?: boolean
  /**
   * `'card'` is spec §3's choice card: the question, then the options as buttons — the office
   * asked something and is waiting.
   *
   * `'chips'` is the next-step row (results UI pass 2, F3): the same options as small ghost
   * chips under the reply, with the question text present only as the group's label. Nothing was
   * asked, so a card would be claiming otherwise — these are suggestions she can ignore, and
   * they have to look like it.
   */
  variant?: 'card' | 'chips'
  onPick: (optionId: string, label: string) => void
}

/**
 * Spec §3's `choices` row, rendered as buttons in the chat: the question and
 * 2 to 4 `btn btn-ghost` buttons, one per option. Pure — no fetch, no
 * router — so `test/web-results-render.test.ts` can render it directly with
 * `renderToStaticMarkup`. The live POST lives in `ChoiceCardLive` below.
 */
export function ChoiceCard({ question, options, disabled, variant = 'card', onPick }: ChoiceCardProps) {
  if (variant === 'chips') {
    return (
      <div className="next-chips" role="group" aria-label={question}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="suggestion"
            disabled={disabled}
            onClick={() => onPick(o.id, o.label)}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="choice-card" role="group" aria-label={question}>
      <p className="choice-question">{question}</p>
      <div className="choice-options">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onPick(o.id, o.label)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export type ChoiceCardLiveProps = {
  conversationId: string
  questionId: string
  question: string
  options: { id: string; label: string }[]
  /** Forwarded to `ChoiceCard` — see its own `variant` prop. */
  variant?: 'card' | 'chips'
}

const GENERIC_ERROR = 'That could not be sent. Please try again.'

/**
 * The client island for a `choices` row: posts the clicked option's LABEL
 * as her own words (`text`), with the ids riding alongside on the operator
 * channel (`choice: { questionId, optionId }`) — spec §3: "A click posts the
 * option label as an ordinary user message; the option id travels alongside
 * ... on the operator channel." `web/messagesRoute.ts`'s `makePost` is the
 * route this hits; `idempotencyKey` is fresh per click, same convention as
 * `MessageBox`/`ProposalCardLive`.
 */
export function ChoiceCardLive({ conversationId, questionId, question, options, variant }: ChoiceCardLiveProps) {
  const router = useRouter()
  const activity = useActivity()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pick(optionId: string, label: string) {
    // Pass 3, section 6b: all three before the fetch. The label IS the message this click posts
    // (spec §3), so it is exactly what the pending bubble should say, and `ThreadLive` owns that
    // list — `activity.optimistic` is how a card this deep in the thread reaches it.
    setPending(true)
    setError(null)
    activity.optimistic(label)
    activity.setBusy(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: label,
          idempotencyKey: crypto.randomUUID(),
          choice: { questionId, optionId },
        }),
      })
      if (!res.ok) {
        setError(GENERIC_ERROR)
        activity.setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
      activity.setBusy(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <ChoiceCard
        question={question} options={options} disabled={pending} variant={variant}
        onPick={(id, label) => void pick(id, label)}
      />
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
