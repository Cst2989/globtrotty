import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations } from '@/web/data'
import { Sidebar } from '@/web/components/Sidebar'
import { MessageBox } from '@/web/components/MessageBox'

/**
 * The landing box: always reachable directly (unlike `/`, which redirects
 * here only when she has no conversation yet — see `app/page.tsx`), so she
 * can always start a fresh one from the sidebar's "New conversation" link
 * even with existing conversations open. `MessageBox`'s `conversationId=
 * 'new'` posts to `/api/conversations/new/messages`, which creates the
 * conversation.
 */
export default async function NewConversationPage() {
  const sb = await createServerSupabase()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) redirect('/login')

  const conversations = await listConversations(sb)

  return (
    <div className="conversation-layout">
      <Sidebar conversations={conversations} />
      <div className="conversation-main">
        <h1>Plan a trip with Globetrotty</h1>
        <MessageBox conversationId="new" />
      </div>
    </div>
  )
}
