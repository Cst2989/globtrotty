import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createServerSupabase } from '@/web/supabase/server'
import {
  listConversations, loadThread, loadProposals, loadResults, loadLatestAction,
  skeletonMode, shouldRecoverResults, threadClaimsResults,
} from '@/web/data'
import { AppShell } from '@/web/components/AppShell'
import { Sidebar } from '@/web/components/Sidebar'
import { ThreadLive } from '@/web/components/Thread'
import { MessageBox } from '@/web/components/MessageBox'
import { TripCardLive } from '@/web/components/TripCard'
import { SplitShell } from '@/web/components/SplitShell'
import { ResultsPaneLive } from '@/web/components/ResultsPane'
import { ResultsRecovery } from '@/web/components/ResultsRecovery'
import { OptimisticProvider } from '@/web/components/optimistic'
import { serverStateFor } from '@/web/components/pending'

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

  const [conversations, thread, proposals, results, latestAction] = await Promise.all([
    listConversations(sb),
    loadThread(sb, id),
    loadProposals(sb, id),
    loadResults(sb, id),
    loadLatestAction(sb, id),
  ])

  if (!thread.conversation) {
    redirect('/c/new')
  }

  /*
   * Polish pass, section 11. The two reads disagree: the transcript holds a `results` row (it is
   * rendering "10 flights shown" right there in the thread) and `loadResults` came back with
   * nothing, so this render is about to be the plain one-column thread over a conversation that
   * has a list of flights in it — rail expanded, no pane, exactly what the author saw.
   *
   * Both reads go through the same RLS-scoped client against the same table, so the
   * disagreement is either a transient read or a bug not yet found. This logs it where a
   * deployed function log will show it, with the conversation id and nothing else, and renders
   * `ResultsRecovery`, which re-reads the page once a second later.
   */
  const claimsResults = threadClaimsResults(thread.messages)
  const recoverResults = shouldRecoverResults({
    threadClaimsResults: claimsResults, resultRows: results.length, alreadyTried: false,
  })
  if (recoverResults) {
    console.error('loadResults: 0 rows for a thread that holds a results row', id)
  }
  // `loadProposals` is newest-first; the results pane only ever shows the
  // current one — whatever `choose`/`decide` most recently touched.
  const proposal = proposals[0] ?? null
  /*
   * Trip-stage pass, section 2: the newest proposal that is both ACCEPTED and holds a stay.
   * `handleChooseFlight` records a flights-only proposal and accepts it on the spot — that
   * acceptance is how the office remembers the flight, not a decision about a trip — so
   * `proposal.decision === 'accept'` is true for the whole of the hotels stage and is not the
   * question the pane is asking.
   */
  const acceptedProposal = proposals.find(
    (p) => p.decision === 'accept' && p.items.some((i) => i.kind === 'hotel'),
  ) ?? null
  const hasResults = results.length > 0
  const latestResultsId = results.length > 0 ? results[results.length - 1]!.messageId : null

  // Results UI pass 2 (E): the split appears the instant a search starts, not when it finishes.
  // `'full'` means there is nothing yet AND something is running, which is also the one case
  // where the split renders without a single `results` row behind it.
  const skeleton = skeletonMode({
    status: thread.conversation.status,
    resultKinds: results.map((r) => r.kind),
    latestAction,
  })

  const chat = (
    <ThreadLive
      userId={user.id}
      conversation={thread.conversation}
      messages={thread.messages}
      latestTurn={thread.latestTurn}
      searching={skeleton !== null}
      composer={<MessageBox conversationId={thread.conversation.id} status={thread.conversation.status} />}
    >
      <TripCardLive conversationId={id} proposals={proposals} />
    </ThreadLive>
  )

  return (
    <AppShell
      title={thread.conversation.title ?? 'New trip'}
      rail={<Sidebar conversations={conversations} activeId={id} userEmail={user.email ?? null} />}
      collapsed={hasResults || skeleton === 'full'}
    >
      {/* Trip-stage pass, section 1: one `OptimisticProvider` above BOTH islands, so a Select
          pressed in the results pane changes the chat column in the same tick, and a chip
          clicked inside the thread changes the pane. It wraps either branch, because the chips
          exist before the first `results` row does. */}
      <OptimisticProvider
        server={serverStateFor({ messages: thread.messages, results, proposals })}
      >
        {hasResults || skeleton === 'full' ? (
          <SplitShell
            conversationId={id}
            chat={chat}
            results={(
              <ResultsPaneLive
                conversationId={id} results={results} proposal={proposal}
                acceptedProposal={acceptedProposal} skeleton={skeleton}
                status={thread.conversation.status}
                failReason={thread.latestTurn?.fail_reason ?? null}
              />
            )}
            latestResultsId={latestResultsId}
          />
        ) : (
          <>
            {chat}
            {recoverResults ? <ResultsRecovery /> : null}
          </>
        )}
      </OptimisticProvider>
    </AppShell>
  )
}
