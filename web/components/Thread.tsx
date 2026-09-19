'use client'

import { useEffect, useState, type ReactNode } from 'react'
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
  children?: ReactNode
}

/**
 * The pure, server-renderable half of the thread: conversation header, the
 * message list (each row through `MessageBubble`, which is what keeps every
 * message plain text — see that component's own doc comment), and an
 * optional `children` slot for the box below. No hooks, no subscription —
 * this whole file carries the `'use client'` boundary for `ThreadLive`
 * below, but `ThreadView` itself takes only props, which is what lets
 * `test/web-render.test.ts` render it directly with `renderToStaticMarkup`.
 */
export function ThreadView({ conversation, messages, latestTurn, children }: ThreadViewProps) {
  return (
    <div className="thread">
      <header className="thread-header">
        <h1>{conversation.title ?? 'New conversation'}</h1>
        <StatusLine status={conversation.status} failReason={latestTurn?.fail_reason ?? null} />
      </header>
      <ul className="thread-messages">
        {messages.map((m) => (
          <li key={m.id}>
            <MessageBubble role={m.role} content={m.content} />
          </li>
        ))}
      </ul>
      {children}
    </div>
  )
}

export type ThreadLiveProps = {
  userId: string
  conversation: ConversationHeader
  messages: ThreadMessage[]
  latestTurn: LatestTurn | null
  children?: ReactNode
}

/**
 * The client island: owns the Realtime subscription (`subscribeConversation`,
 * `web/realtime.ts`) and calls `router.refresh()` on every change — the
 * server component (`app/c/[id]/page.tsx`) re-runs `loadThread` and this
 * re-renders with fresh, RLS-scoped data. The subscription payload itself is
 * never read (see `web/realtime.ts`'s doc comment). `children` is the
 * `MessageBox` — passed in by the caller rather than rendered here, so this
 * component doesn't need to know the message-box's own disabled logic.
 *
 * The browser Supabase client is created here, lazily, with `useState`'s
 * initializer form (so it is built exactly once per mount) rather than
 * accepted as a prop: a Supabase client instance is not serialisable across
 * the server/client boundary, so a Server Component parent can only pass it
 * plain, JSON-safe props (`userId`, the loaded thread data) and let this
 * client component build its own client.
 */
export function ThreadLive({ userId, conversation, messages, latestTurn, children }: ThreadLiveProps) {
  const router = useRouter()
  const [sb] = useState(() => createBrowserSupabase())

  useEffect(() => {
    return subscribeConversation(sb, {
      conversationId: conversation.id,
      userId,
      onChange: () => router.refresh(),
    })
  }, [sb, userId, conversation.id, router])

  return (
    <ThreadView conversation={conversation} messages={messages} latestTurn={latestTurn}>
      {children}
    </ThreadView>
  )
}
