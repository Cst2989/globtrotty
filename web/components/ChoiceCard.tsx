'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOptimistic } from './optimistic'

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
  const optimistic = useOptimistic()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(
    optionId: string, label: string, idempotencyKey: string,
    entries: { message: string; action: string },
  ) {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: label,
          idempotencyKey,
          choice: { questionId, optionId },
        }),
      })
      if (!res.ok) {
        setError(GENERIC_ERROR)
        optimistic.fail(entries.action)
        optimistic.fail(entries.message)
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
      optimistic.fail(entries.action)
      optimistic.fail(entries.message)
    } finally {
      setPending(false)
    }
  }

  /**
   * Trip-stage pass, section 1: both writes happen before the fetch. The label IS the message
   * this click posts (spec §3), so it is exactly what the pending bubble should say; the action
   * entry beside it is what keeps the status line and the thinking row up while the turn runs.
   * A `next` chip and a question card's option are told apart because they are different things
   * to the office — one is a suggestion she took, the other an answer she gave.
   */
  function pick(optionId: string, label: string) {
    const idempotencyKey = crypto.randomUUID()
    const entries = { message: '', action: '' }
    entries.message = optimistic.add({
      kind: 'message',
      text: label,
      idempotencyKey,
      onRetry: () => void post(optionId, label, idempotencyKey, entries),
    })
    entries.action = optimistic.add({
      kind: variant === 'chips' ? 'next' : 'choice',
      text: label,
    })
    void post(optionId, label, idempotencyKey, entries)
  }

  return (
    <>
      <ChoiceCard
        question={question} options={options} disabled={pending} variant={variant}
        onPick={(id, label) => pick(id, label)}
      />
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
