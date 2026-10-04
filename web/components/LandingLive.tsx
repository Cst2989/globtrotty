'use client'

import { useState } from 'react'
import { ArrowUp } from '@phosphor-icons/react'
import { MessageBox, messageForStatus } from './MessageBox'
import { ThreadView } from './Thread'
import { SplitShell } from './SplitShell'
import { ResultsPane } from './ResultsPane'
import { withViewTransition } from './transition'

const SUGGESTIONS = [
  'A week in Portugal in September for two',
  'Long weekend in Copenhagen from Berlin',
  'Ten days in Japan in spring',
]

/** Photo tiles behind the landing, all self-hosted (see public/landing/CREDITS.md). */
const TILES = [
  { src: '/landing/lisbon.webp', alt: '' },
  { src: '/landing/dolomites.webp', alt: '' },
  { src: '/landing/santorini.webp', alt: '' },
  { src: '/landing/kyoto.webp', alt: '' },
  { src: '/landing/beach.webp', alt: '' },
  { src: '/landing/copenhagen.webp', alt: '' },
  { src: '/landing/marrakech.webp', alt: '' },
  { src: '/landing/newyork.webp', alt: '' },
]

export type LandingLiveProps = {
  /**
   * Injectable so `test/web-render.test.ts` can render the `'sent'` half without a fetch or a
   * router; production always starts at `'idle'` and gets to `'sent'` through a real send.
   */
  phase?: 'idle' | 'sent'
}

/** What her words and the alert come back as after a failed first send — see `onOptimisticError`. */
type Restore = { text: string; error: string | null; nonce: number }

const NO_RESTORE: Restore = { text: '', error: null, nonce: 0 }

/**
 * The composer for the one second the optimistic split is on screen: the real one's shape,
 * inert. A live `MessageBox` here would be a second composer with its own empty state, mounted
 * only to be unmounted again by the navigation a moment later — and nothing can usefully be
 * typed into it, because the conversation it would post to does not have an id yet. The
 * conversation page's own composer is disabled in exactly this state (`status: 'working'`), so
 * this is what she would see there anyway.
 */
function SentComposer() {
  return (
    <div className="message-box">
      <div className="composer">
        <label htmlFor="landing-sent-composer" className="visually-hidden">Message</label>
        <textarea
          id="landing-sent-composer" rows={1} disabled
          placeholder="The desk is working on your last message"
        />
        <button type="button" className="btn composer-send" disabled aria-label="Sending">
          <ArrowUp size={18} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <p className="composer-hint">
        Prices come from live searches. Globetrotty never asks for payment or passport details.
      </p>
    </div>
  )
}

/**
 * Pass 3, section 5: the landing, and the SPLIT it becomes the instant she presses send.
 *
 * The bug this fixes is three seconds of nothing. The old flow was: press send, POST
 * `/api/conversations/new/messages`, wait for the route to create the conversation and queue the
 * turn, then `router.push('/c/<id>')` and wait again for that page to server-render. Both waits
 * are on the network, and for the whole of them the screen was the landing photo wall with an
 * emptied composer — the one moment in the product where she is least sure anything happened.
 *
 * Nothing about that was the server's fault and nothing about it needed the server: the page she
 * is going to is fully determined by what she just typed. So `phase` flips to `'sent'`
 * SYNCHRONOUSLY, inside `MessageBox`'s `onOptimistic` (which fires before `fetch` is even
 * called), and this renders the same `SplitShell` the conversation page renders, with the same
 * three things in it: her message as a pending bubble, the status line reading "Searching", and
 * `ResultsPane`'s own `'full'` skeleton. The POST then runs in the background and
 * `router.replace`s onto the real conversation (see `MessageBox`), where the server renders the
 * identical state — so the swap is visually a no-op and Realtime takes it from there.
 *
 * The swap runs inside a View Transition (`withViewTransition`), which is what cross-fades the
 * photo wall out instead of cutting; the `.split-pane-chat`/`.split-pane-results` transition
 * names are already in `app/globals.css` for the navigation that follows, so the two animations
 * are the same two animations.
 *
 * On a failure that wrote nothing usable (`landingPhaseAfterResponse`), `onOptimisticError`
 * brings the landing back with her words restored and the existing alert copy above the box.
 * A fresh `MessageBox` mounts for that — the hero and the split are different subtrees, so the
 * instance that made the request is gone by then — which is what `initialText`/`initialError`
 * and the `key` below are for.
 */
export function LandingLive({ phase: initialPhase = 'idle' }: LandingLiveProps) {
  const [phase, setPhase] = useState<'idle' | 'sent'>(initialPhase)
  const [sentText, setSentText] = useState('')
  const [restore, setRestore] = useState<Restore>(NO_RESTORE)

  if (phase === 'sent') {
    return (
      <SplitShell
        conversationId="new"
        latestResultsId={null}
        chat={(
          <ThreadView
            // The conversation does not exist yet, which is exactly why this is optimistic. Its
            // id is never used for anything here: no fetch, no subscription, no storage key that
            // outlives the swap a moment later.
            conversation={{ id: 'new', title: null, status: 'working', updated_at: '' }}
            messages={[{ id: 'pending', role: 'user', content: sentText, created_at: '', pending: true }]}
            latestTurn={null}
            searching
            composer={<SentComposer />}
          />
        )}
        results={(
          <ResultsPane
            results={[]} proposal={null} pending={false} error={null} skeleton="full"
            onChoose={() => {}} onGetLinks={() => {}} onRefresh={() => {}}
          />
        )}
      />
    )
  }

  return (
    <div className="hero">
      <div className="hero-wall" aria-hidden="true">
        {TILES.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={t.src} src={t.src} alt={t.alt} loading="eager" decoding="async" />
        ))}
      </div>
      <div className="hero-inner">
        <h1>Where to next?</h1>
        <p>Say it in your own words. The desk searches live flights and hotels and comes back with a plan.</p>
        <MessageBox
          key={restore.nonce}
          conversationId="new"
          variant="hero"
          quickOptions
          suggestions={SUGGESTIONS}
          placeholder="Somewhere warm in October, two of us, near the sea"
          initialText={restore.text}
          initialError={restore.error}
          onOptimistic={(text) => {
            // Synchronous, before the POST: this is the whole point of the section.
            setSentText(text)
            withViewTransition(() => setPhase('sent'))
          }}
          onOptimisticError={(text, status) => {
            setRestore((current) => ({ text, error: messageForStatus(status), nonce: current.nonce + 1 }))
            withViewTransition(() => setPhase('idle'))
          }}
        />
      </div>
    </div>
  )
}
