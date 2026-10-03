'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type ChoiceCardProps = {
  question: string
  options: { id: string; label: string }[]
  /** Disables every button while a request from the live wrapper is in flight. */
  disabled?: boolean
  onPick: (optionId: string, label: string) => void
}

/**
 * Spec §3's `choices` row, rendered as buttons in the chat: the question and
 * 2 to 4 `btn btn-ghost` buttons, one per option. Pure — no fetch, no
 * router — so `test/web-results-render.test.ts` can render it directly with
 * `renderToStaticMarkup`. The live POST lives in `ChoiceCardLive` below.
 */
export function ChoiceCard({ question, options, disabled, onPick }: ChoiceCardProps) {
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
export function ChoiceCardLive({ conversationId, questionId, question, options }: ChoiceCardLiveProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pick(optionId: string, label: string) {
    setPending(true)
    setError(null)
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
        return
      }
      router.refresh()
    } catch {
      setError(GENERIC_ERROR)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <ChoiceCard question={question} options={options} disabled={pending} onPick={(id, label) => void pick(id, label)} />
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
