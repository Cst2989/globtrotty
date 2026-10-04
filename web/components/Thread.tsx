'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { ConversationHeader, LatestTurn, ThreadMessage } from '@/web/data'
import { subscribeConversation } from '@/web/realtime'
import { createBrowserSupabase } from '@/web/supabase/browser'
import { actionNote, mergePending, type MergedMessage } from './pending'
import { useOptimistic } from './optimistic'
import { MessageBubble } from './MessageBubble'
import { StatusLine } from './StatusLine'

/**
 * Streamed reveal: the extra, all-optional fields `ThreadLive` attaches to a just-arrived
 * `agent` row (see its own doc comment) so `ThreadView` — which stays hook-free, see below — can
 * decide, from props alone, whether to stream that row's text and whether to hold back whatever
 * `results`/`action`/`choices` row follows it in the same turn.
 */
export type RevealableMessage = (ThreadMessage | MergedMessage) & {
  animate?: boolean
  revealed?: boolean
  onRevealed?: () => void
}

export type ThreadViewProps = {
  conversation: ConversationHeader
  messages: RevealableMessage[]
  latestTurn: LatestTurn | null
  /** Rendered inside the scrolling column, after the messages (proposal cards). */
  children?: ReactNode
  /** Rendered in the sticky region under the scroll area (the message box). */
  composer?: ReactNode
  /** Optional sentinel the live wrapper scrolls into view on new content. */
  tail?: ReactNode
  /**
   * Task 10: true while `ThreadLive` has at least one optimistic message
   * still unmatched to a server row — or while a chip or choice card has
   * just been clicked (pass 3, section 6b).
   *
   * While true AND the real `status` has not yet flipped to `working`, the
   * line reads what the turn is ABOUT to be doing rather than what the
   * stored status still says (`active`'s "Ready for your next message" being
   * the usual case right in the half-second after a send): "Searching" when
   * the results pane is already promising a list, "Thinking" otherwise.
   *
   * It used to read "Sending", which was honest about the network and wrong
   * about the product — pass 3, section 5e: the only thing she cares about
   * in that moment is that the desk has her message and is working on it.
   */
  sending?: boolean
  /**
   * Results UI pass 2 (E): true while the results pane is showing a skeleton, i.e. a SEARCH is
   * what the turn is doing. The status line then reads "Searching" instead of the generic
   * "Thinking", which is the same substitution `sending` already makes and for the same reason:
   * the honest word costs nothing and "Thinking" beside five shimmering flight cards is wrong
   * about what is happening.
   */
  searching?: boolean
  /**
   * Pass 3: the results pane is re-running an expired search of its own accord, so the line
   * reads "Updating prices". It wins over everything else, including a real `working` status —
   * the turn that IS working is the refresh.
   */
  updating?: boolean
  /**
   * Task 10's LOAD-BEARING gap, closed by the final review's fix wave: without
   * this, `MessageBubble` always took its inert `ChoiceCard` branch with
   * `onPick={() => {}}`, so every choice card in production — intake's and the
   * driver's `offer_choices` alike — rendered as buttons that did nothing.
   * `ThreadLive` passes `conversation.id`.
   *
   * Deliberately a SEPARATE prop rather than read off `conversation.id` inside
   * the function: `ThreadView` is rendered with `renderToStaticMarkup` in
   * test/web-render.test.ts, and reading it from `conversation` would make
   * every one of those pure cases start mounting `ChoiceCardLive`, which calls
   * `useRouter()`. Leaving it optional keeps the static renders static and
   * makes the live wiring an explicit choice at exactly one call site.
   */
  conversationId?: string
  /**
   * Trip-stage pass, section 1: the words the pending-action note reads, or `null` for no note.
   * It is a centred `data-pending` row under the messages, exactly where the server's own
   * `action` row will land a round trip later saying the same thing — see `actionNote`.
   */
  pendingNote?: string | null
  /** Re-posts the optimistic message whose POST failed — see `MessageBubbleProps.onRetry`. */
  onRetry?: (pendingId: string) => void
}

/**
 * The pure, server-renderable half of the thread: a header with the title
 * and status, a scrolling column of messages (each through `MessageBubble`,
 * which is what keeps every message plain text), `children` for the cards,
 * and a `composer` slot pinned below the scroll area. No hooks, no
 * subscription; this file carries the `'use client'` boundary for
 * `ThreadLive` below, but `ThreadView` takes only props, which is what lets
 * `test/web-render.test.ts` render it with `renderToStaticMarkup`.
 */
export function ThreadView(
  {
    conversation, messages, latestTurn, children, composer, tail, sending, searching, updating,
    conversationId, pendingNote = null, onRetry,
  }: ThreadViewProps,
) {
  const working = updating === true
    || conversation.status === 'working'
    || (sending === true && conversation.status !== 'working')
  const effectiveStatus = updating
    ? 'updating'
    : (working ? (searching ? 'searching' : 'working') : conversation.status)

  return (
    <div className="thread">
      <div className="thread-scroll">
        <div className="thread-column">
          <header className="thread-header">
            <h1>{conversation.title ?? 'New trip'}</h1>
            <StatusLine status={effectiveStatus} failReason={latestTurn?.fail_reason ?? null} />
          </header>
          <ul className="thread-messages">
            {(() => {
              // Streamed reveal: a plain `let`, recomputed fresh every render — no hooks needed,
              // which is what keeps this function callable directly (see the "forwards
              // conversationId" test's own doc comment). True for the stretch of rows, right
              // after a still-revealing agent message, that belong to the SAME turn: the next
              // non-marker row (a `user` message, or an agent row that is not still revealing)
              // always closes the window.
              let awaitingReveal = false
              return messages.map((m) => {
                const isMarkerOrChoice = m.role === 'results' || m.role === 'action' || m.role === 'choices'
                const gatedForThisRow = isMarkerOrChoice && awaitingReveal
                if (m.role === 'agent') {
                  awaitingReveal = m.animate === true && m.revealed !== true
                } else if (!isMarkerOrChoice) {
                  awaitingReveal = false
                }
                return (
                  <li key={m.id}>
                    <MessageBubble
                      role={m.role}
                      content={m.content}
                      conversationId={conversationId}
                      pending={'pending' in m ? m.pending : undefined}
                      failed={'failed' in m ? m.failed : undefined}
                      onRetry={'pendingId' in m && m.pendingId && onRetry
                        ? () => onRetry(m.pendingId!)
                        : undefined}
                      animate={m.animate}
                      onRevealed={m.onRevealed}
                      gated={gatedForThisRow}
                    />
                  </li>
                )
              })
            })()}
          </ul>
          {/* Section 1: what she just did, said in the chat in the same tick she did it, in the
              place and the words the server's own `action` row will use once it lands. */}
          {pendingNote ? (
            <div className="message-row" data-role="action" data-pending="true">
              <p className="message message-action" data-role="action">{pendingNote}</p>
            </div>
          ) : null}
          {/* Pass 3, section 5e/6b: driven by the same `working` as the status line, so the
              typing dots appear in the tick she presses send rather than after the POST. */}
          {working ? (
            <div className="message-row" data-role="agent" aria-hidden="true">
              <p className="message thinking-row">
                <span className="thinking">
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            </div>
          ) : null}
          {children}
          {tail}
        </div>
      </div>
      {composer ? <div className="composer-region">{composer}</div> : null}
    </div>
  )
}

export type ThreadLiveProps = {
  userId: string
  conversation: ConversationHeader
  messages: ThreadMessage[]
  latestTurn: LatestTurn | null
  children?: ReactNode
  composer?: ReactNode
  /** Forwarded to `ThreadView` — see its own `searching` prop. */
  searching?: boolean
}

/**
 * The client island: owns the Realtime subscription (`subscribeConversation`,
 * `web/realtime.ts`) and calls `router.refresh()` on every change; the server component
 * (`app/c/[id]/page.tsx`) re-runs `loadThread` and this re-renders with fresh, RLS-scoped data.
 * The subscription payload itself is never read (see `web/realtime.ts`). It also keeps the
 * column scrolled to the newest content, the way every chat client does, whenever the message
 * count or the status changes.
 *
 * The browser Supabase client is created lazily with `useState`'s initializer so it is built
 * exactly once per mount; a client instance is not serialisable across the server/client
 * boundary, so the Server Component parent passes only JSON-safe props.
 *
 * Trip-stage pass, section 1: this no longer owns any optimistic state. The pending bubbles, the
 * pending-action note, the thinking row and the status line all read ONE store
 * (`./optimistic.tsx`), which the pane writes to as well — which is the whole point: a Select
 * pressed in the pane changes this column in the same tick, and a chip clicked in this column
 * changes the pane. The merge is still `mergePending` (`./pending.ts`), pure, unit-tested
 * directly; what changed is that the store has already settled anything the server carries, so
 * the merge no longer has a drop rule of its own.
 *
 * Streamed reveal: `mountedIdsRef` is the set of message ids this instance opened with, so an
 * `agent` row that shows up afterward (the ordinary case, a reply landing through the Realtime
 * refresh above) gets `animate: true` and streams through `StreamedText`, while everything that
 * was already on the page at load renders instantly, same as before this feature existed.
 * `revealedIds` tracks which of those have finished streaming, so the `results`/`action` marker
 * or `choices` row (the `next` chips included) that follows one in the same turn can stay out of
 * the way — `ThreadView` does the actual gating, from these two plain props, with no hooks of its
 * own; see `RevealableMessage`.
 */
export function ThreadLive({ userId, conversation, messages, latestTurn, children, composer, searching }: ThreadLiveProps) {
  const router = useRouter()
  const optimistic = useOptimistic()
  const [sb] = useState(() => createBrowserSupabase())
  const tailRef = useRef<HTMLDivElement>(null)

  /**
   * Streamed reveal: every message id present the FIRST time this component rendered — on the
   * server and again on hydration, from the same initial `messages` prop, so both passes agree
   * and there is no hydration mismatch. Captured once (the lazy `if` below only ever runs on the
   * very first render) and never updated after, so anything that shows up later through a
   * Realtime-triggered `router.refresh()` is, by definition, not in it.
   */
  const mountedIdsRef = useRef<Set<string> | null>(null)
  if (mountedIdsRef.current === null) {
    mountedIdsRef.current = new Set(messages.map((m) => m.id))
  }
  // Ids of agent messages whose `StreamedText` reveal has finished. Only ever grows; a message
  // never in here and not in `mountedIdsRef` is the one currently streaming.
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(() => new Set())
  function markRevealed(id: string) {
    setRevealedIds((current) => {
      if (current.has(id)) return current
      const next = new Set(current)
      next.add(id)
      return next
    })
  }

  useEffect(() => {
    return subscribeConversation(sb, {
      conversationId: conversation.id,
      userId,
      onChange: () => router.refresh(),
    })
  }, [sb, userId, conversation.id, router])

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, conversation.status, optimistic.pendingMessages.length])

  const mergedMessages = mergePending(messages, optimistic.pendingMessages)

  // Streamed reveal: an agent row not already on the page at mount streams in; `revealed` and
  // `onRevealed` are only meaningful for those, so every other row (including the pending-merge
  // additions, which are always `role: 'user'`) passes through untouched.
  const revealableMessages: RevealableMessage[] = mergedMessages.map((m) => {
    if (m.role !== 'agent' || mountedIdsRef.current!.has(m.id)) return m
    return {
      ...m,
      animate: true,
      revealed: revealedIds.has(m.id),
      onRevealed: () => markRevealed(m.id),
    }
  })

  const note = optimistic.pendingAction === null ? '' : actionNote(optimistic.pendingAction.kind)

  return (
    <ThreadView
      conversation={conversation}
      conversationId={conversation.id}
      messages={revealableMessages}
      latestTurn={latestTurn}
      composer={composer}
      sending={optimistic.busy}
      searching={searching}
      updating={optimistic.updating}
      pendingNote={note === '' ? null : note}
      onRetry={(pendingId) => optimistic.retry(pendingId)}
      tail={<div ref={tailRef} aria-hidden="true" />}
    >
      {children}
    </ThreadView>
  )
}
