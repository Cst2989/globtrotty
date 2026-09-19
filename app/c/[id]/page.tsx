import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations, loadThread, loadProposals, loadAlternatives } from '@/web/data'
import { Sidebar } from '@/web/components/Sidebar'
import { ThreadLive } from '@/web/components/Thread'
import { MessageBox } from '@/web/components/MessageBox'
import { ProposalCardLive } from '@/web/components/ProposalCard'

/**
 * The proxy (`proxy.ts` → `web/supabase/middleware.ts`) already redirects an
 * unauthenticated request to `/login` before it reaches here, but the check
 * is repeated (matching `app/page.tsx`'s existing pattern) rather than
 * relying on that alone — belt and braces for a page that reads a specific
 * conversation.
 *
 * `loadThread` returning `conversation: null` covers both "no such id" and
 * "belongs to someone else": RLS makes those indistinguishable, so both
 * send her back to the landing box rather than confirming which one it was.
 *
 * Fix round 1 (Minor): a non-uuid `id` (a stray path segment, a typo'd
 * link) is rejected the same way — `/c/new` — before it ever reaches
 * `loadThread`/Postgres, rather than trusting a malformed string to a
 * `uuid`-typed column comparison.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    redirect('/c/new')
  }

  const sb = await createServerSupabase()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) redirect('/login')

  const [conversations, thread, proposals, flightAlternatives, hotelAlternatives] = await Promise.all([
    listConversations(sb),
    loadThread(sb, id),
    loadProposals(sb, id),
    loadAlternatives(sb, id, 'flight'),
    loadAlternatives(sb, id, 'hotel'),
  ])

  if (!thread.conversation) {
    redirect('/c/new')
  }

  const alternatives = { flight: flightAlternatives, hotel: hotelAlternatives }

  return (
    <div className="conversation-layout">
      <Sidebar conversations={conversations} activeId={id} />
      <div className="conversation-main">
        <ThreadLive
          userId={user.id}
          conversation={thread.conversation}
          messages={thread.messages}
          latestTurn={thread.latestTurn}
        >
          {proposals.map((proposal) => (
            <ProposalCardLive key={proposal.id} proposal={proposal} alternatives={alternatives} />
          ))}
          <MessageBox conversationId={thread.conversation.id} status={thread.conversation.status} />
        </ThreadLive>
      </div>
    </div>
  )
}
