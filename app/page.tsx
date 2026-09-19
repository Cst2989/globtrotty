import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations } from '@/web/data'
import { Sidebar } from '@/web/components/Sidebar'
import { MessageBox } from '@/web/components/MessageBox'

/**
 * Sends her straight back into her most recently updated conversation, if
 * she has one — the old unconditional `redirect('/c/new')` lost that state
 * on every visit. With none yet, this renders the same landing box
 * `app/c/new/page.tsx` does.
 */
export default async function HomePage() {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const conversations = await listConversations(supabase)
  if (conversations.length > 0) {
    redirect(`/c/${conversations[0]!.id}`)
  }

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
