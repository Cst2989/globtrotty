import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations } from '@/web/data'
import { AppShell } from '@/web/components/AppShell'
import { Sidebar } from '@/web/components/Sidebar'
import { Landing } from '@/web/components/Landing'

/**
 * The landing box: always reachable directly (unlike `/`, which redirects
 * here only when she has no conversation yet), so she can start a fresh
 * trip from the rail even with existing conversations open. The box posts
 * to `/api/conversations/new/messages`, which creates the conversation.
 */
export default async function NewConversationPage() {
  const sb = await createServerSupabase()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) redirect('/login')

  const conversations = await listConversations(sb)

  return (
    <AppShell
      title="New trip"
      rail={<Sidebar conversations={conversations} userEmail={user.email ?? null} />}
    >
      <Landing />
    </AppShell>
  )
}
