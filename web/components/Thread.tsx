'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { ConversationHeader, LatestTurn, ThreadMessage } from '@/web/data'
import { subscribeConversation } from '@/web/realtime'
import { createBrowserSupabase } from '@/web/supabase/browser'
import { MessageBubble } from './MessageBubble'
import { StatusLine } from './StatusLine'

export type ThreadViewProps = {
  conversation: ConversationHeader
  messages: ThreadMessage[]
  latestTurn: LatestTurn | null
  /** Rendered inside the scrolling column, after the messages (proposal cards). */
  children?: ReactNode
  /** Rendered in the sticky region under the scroll area (the message box). */
  composer?: ReactNode
  /** Optional sentinel the live wrapper scrolls into view on new content. */
  tail?: ReactNode
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
export function ThreadView({ conversation, messages, latestTurn, children, composer, tail }: ThreadViewProps) {
  return (
    <div className="thread">
      <div className="thread-scroll">
        <div className="thread-column">
          <header className="thread-header">
            <h1>{conversation.title ?? 'New trip'}</h1>
            <StatusLine status={conversation.status} failReason={latestTurn?.fail_reason ?? null} />
          </header>
          <ul className="thread-messages">
            {messages.map((m) => (
              <li key={m.id}>
                <MessageBubble role={m.role} content={m.content} />
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
}

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
 */
export function ThreadLive({ userId, conversation, messages, latestTurn, children, composer }: ThreadLiveProps) {
  const router = useRouter()
  const [sb] = useState(() => createBrowserSupabase())
  const tailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return subscribeConversation(sb, {
      conversationId: conversation.id,
      userId,
      onChange: () => router.refresh(),
    })
  }, [sb, userId, conversation.id, router])

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, conversation.status])

  return (
    <ThreadView
      conversation={conversation}
      messages={messages}
      latestTurn={latestTurn}
      composer={composer}
      tail={<div ref={tailRef} aria-hidden="true" />}
    >
      {children}
    </ThreadView>
  )
}
