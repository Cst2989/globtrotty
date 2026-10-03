import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations, loadThread, loadProposals, loadAlternatives, loadResults } from '@/web/data'
import { AppShell } from '@/web/components/AppShell'
import { Sidebar } from '@/web/components/Sidebar'
import { ThreadLive } from '@/web/components/Thread'
import { MessageBox } from '@/web/components/MessageBox'
import { ProposalCardLive } from '@/web/components/ProposalCard'
import { SplitShell } from '@/web/components/SplitShell'
import { ResultsPaneLive } from '@/web/components/ResultsPane'

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

  const [conversations, thread, proposals, flightAlternatives, hotelAlternatives, results] = await Promise.all([
    listConversations(sb),
    loadThread(sb, id),
    loadProposals(sb, id),
    loadAlternatives(sb, id, 'flight'),
    loadAlternatives(sb, id, 'hotel'),
    loadResults(sb, id),
  ])

  if (!thread.conversation) {
    redirect('/c/new')
  }

  const alternatives = { flight: flightAlternatives, hotel: hotelAlternatives }
  // `loadProposals` is newest-first; the results pane only ever shows the
  // current one — whatever `choose`/`decide` most recently touched.
  const proposal = proposals[0] ?? null
  const hasResults = results.length > 0
  const latestResultsId = results.length > 0 ? results[results.length - 1]!.messageId : null

  const chat = (
    <ThreadLive
      userId={user.id}
      conversation={thread.conversation}
      messages={thread.messages}
      latestTurn={thread.latestTurn}
      composer={<MessageBox conversationId={thread.conversation.id} status={thread.conversation.status} />}
    >
      {proposals.map((p) => (
        <ProposalCardLive key={p.id} proposal={p} alternatives={alternatives} />
      ))}
    </ThreadLive>
  )

  return (
    <AppShell
      title={thread.conversation.title ?? 'New trip'}
      rail={<Sidebar conversations={conversations} activeId={id} userEmail={user.email ?? null} />}
      collapsed={hasResults}
    >
      {hasResults ? (
        <SplitShell
          conversationId={id}
          chat={chat}
          results={<ResultsPaneLive conversationId={id} results={results} proposal={proposal} />}
          latestResultsId={latestResultsId}
        />
      ) : (
        chat
      )}
    </AppShell>
  )
}
