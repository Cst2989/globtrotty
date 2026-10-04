'use client'

import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { ConversationHeader, LatestTurn, ThreadMessage } from '@/web/data'
import { subscribeConversation } from '@/web/realtime'
import { createBrowserSupabase } from '@/web/supabase/browser'
import { mergePending, type MergedMessage, type PendingMessage } from './pending'
import { MessageBubble } from './MessageBubble'
import { StatusLine } from './StatusLine'
import type { MessageBoxProps } from './MessageBox'

export type ThreadViewProps = {
  conversation: ConversationHeader
  messages: (ThreadMessage | MergedMessage)[]
  latestTurn: LatestTurn | null
  /** Rendered inside the scrolling column, after the messages (proposal cards). */
  children?: ReactNode
  /** Rendered in the sticky region under the scroll area (the message box). */
  composer?: ReactNode
  /** Optional sentinel the live wrapper scrolls into view on new content. */
  tail?: ReactNode
  /**
   * Task 10: true while `ThreadLive` has at least one optimistic message
   * still unmatched to a server row. While true AND the real `status` has
   * not yet flipped to `working`, the status line shows "Sending" instead
   * of whatever `status` would otherwise say (`active`'s stale "Ready for
   * your next message" being the usual case right after a send) — see
   * `StatusLine`'s own `sending` entry.
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
  { conversation, messages, latestTurn, children, composer, tail, sending, searching, conversationId }: ThreadViewProps,
) {
  const effectiveStatus = sending && conversation.status !== 'working'
    ? 'sending'
    : (searching && conversation.status === 'working' ? 'searching' : conversation.status)

  return (
    <div className="thread">
      <div className="thread-scroll">
        <div className="thread-column">
          <header className="thread-header">
            <h1>{conversation.title ?? 'New trip'}</h1>
            <StatusLine status={effectiveStatus} failReason={latestTurn?.fail_reason ?? null} />
          </header>
          <ul className="thread-messages">
            {messages.map((m) => (
              <li key={m.id}>
                <MessageBubble
                  role={m.role}
                  content={m.content}
                  conversationId={conversationId}
                  pending={'pending' in m ? m.pending : undefined}
                />
              </li>
            ))}
          </ul>
          {conversation.status === 'working' ? (
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

/** How long an optimistic message waits for a matching server row before it is dropped anyway (Task 10 brief). */
const PENDING_TIMEOUT_MS = 30_000

/**
 * The client island: owns the Realtime subscription (`subscribeConversation`,
 * `web/realtime.ts`) and calls `router.refresh()` on every change; the
 * server component (`app/c/[id]/page.tsx`) re-runs `loadThread` and this
 * re-renders with fresh, RLS-scoped data. The subscription payload itself is
 * never read (see `web/realtime.ts`). It also keeps the column scrolled to
 * the newest content, the way every chat client does, whenever the message
 * count or the status changes.
 *
 * The browser Supabase client is created lazily with `useState`'s
 * initializer so it is built exactly once per mount; a client instance is
 * not serialisable across the server/client boundary, so the Server
 * Component parent passes only JSON-safe props.
 *
 * Task 10, optimistic send: `composer` arrives as an already-built
 * `<MessageBox .../>` element (the server-rendered page decides its
 * `conversationId`/`status` props); this wraps it with `cloneElement` to
 * inject `onOptimistic`/`onOptimisticError` without the page needing to
 * know anything about pending state. `onOptimistic` appends a
 * `PendingMessage` (and schedules its own `PENDING_TIMEOUT_MS` fallback
 * removal); `onOptimisticError` removes one by content when the POST itself
 * failed outright (not the 409/busy or 429/limit cases, which DID write her
 * message — see `MessageBox.messageForStatus`'s own doc comment — so there
 * the pending bubble is left for the next refresh to match and drop). The
 * merge itself is `mergePending` (`./pending.ts`), a pure function so it is
 * unit-tested directly rather than through this component.
 */
export function ThreadLive({ userId, conversation, messages, latestTurn, children, composer, searching }: ThreadLiveProps) {
  const router = useRouter()
  const [sb] = useState(() => createBrowserSupabase())
  const tailRef = useRef<HTMLDivElement>(null)
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  function dropPending(predicate: (p: PendingMessage) => boolean) {
    setPendingMessages((current) => {
      const keep: PendingMessage[] = []
      for (const p of current) {
        if (predicate(p)) {
          const timer = timersRef.current.get(p.id)
          if (timer) clearTimeout(timer)
          timersRef.current.delete(p.id)
        } else {
          keep.push(p)
        }
      }
      return keep
    })
  }

  useEffect(() => {
    return subscribeConversation(sb, {
      conversationId: conversation.id,
      userId,
      onChange: () => router.refresh(),
    })
  }, [sb, userId, conversation.id, router])

  // A refresh landed: drop any pending message the server has now matched
  // by content (see `mergePending`'s own doc comment for why content, not id).
  useEffect(() => {
    dropPending((p) => messages.some((m) => m.role === 'user' && m.content === p.content))
    // `dropPending` closes over `setPendingMessages` and `timersRef` only —
    // both stable across renders — so `[messages]` is the complete, correct
    // dependency list even though the function itself is not in it.
  }, [messages])

  // Every timer this instance has ever started is cleared on unmount — a
  // change that arrives right before unmount must never fire into a
  // torn-down component.
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, conversation.status, pendingMessages.length])

  const mergedMessages = mergePending(messages, pendingMessages)

  const liveComposer =
    composer && isValidElement(composer)
      ? cloneElement(composer as ReactElement<MessageBoxProps>, {
          onOptimistic: (text: string) => {
            const id = crypto.randomUUID()
            setPendingMessages((current) => [...current, { id, content: text }])
            const timer = setTimeout(() => dropPending((p) => p.id === id), PENDING_TIMEOUT_MS)
            timersRef.current.set(id, timer)
          },
          onOptimisticError: (text: string) => {
            dropPending((p) => p.content === text)
          },
        })
      : composer

  return (
    <ThreadView
      conversation={conversation}
      conversationId={conversation.id}
      messages={mergedMessages}
      latestTurn={latestTurn}
      composer={liveComposer}
      sending={pendingMessages.length > 0}
      searching={searching}
      tail={<div ref={tailRef} aria-hidden="true" />}
    >
      {children}
    </ThreadView>
  )
}
