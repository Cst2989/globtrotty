import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations, loadThread, loadProposals, loadAlternatives } from '@/web/data'
import { AppShell } from '@/web/components/AppShell'
import { Sidebar } from '@/web/components/Sidebar'
import { ThreadLive } from '@/web/components/Thread'
import { MessageBox } from '@/web/components/MessageBox'
import { ProposalCardLive } from '@/web/components/ProposalCard'

/**
 * The proxy (`proxy.ts` → `web/supabase/middleware.ts`) already redirects an
 * unauthenticated request to `/login` before it reaches here, but the check
 * is repeated: belt and braces for a page that reads a specific conversation.
 *
 * `loadThread` returning `conversation: null` covers both "no such id" and
 * "belongs to someone else": RLS makes those indistinguishable, so both send
 * her back to the landing box rather than confirming which one it was. A
 * non-uuid `id` is rejected the same way before it reaches Postgres.
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
    <AppShell
      title={thread.conversation.title ?? 'New trip'}
      rail={<Sidebar conversations={conversations} activeId={id} userEmail={user.email ?? null} />}
    >
      <ThreadLive
        userId={user.id}
        conversation={thread.conversation}
        messages={thread.messages}
        latestTurn={thread.latestTurn}
        composer={<MessageBox conversationId={thread.conversation.id} status={thread.conversation.status} />}
      >
        {proposals.map((proposal) => (
          <ProposalCardLive key={proposal.id} proposal={proposal} alternatives={alternatives} />
        ))}
      </ThreadLive>
    </AppShell>
  )
}
