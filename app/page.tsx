import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/web/supabase/server'
import { listConversations } from '@/web/data'
import { AppShell } from '@/web/components/AppShell'
import { Sidebar } from '@/web/components/Sidebar'
import { Landing } from '@/web/components/Landing'

/**
 * Sends her straight back into her most recently updated conversation, if
 * she has one. With none yet, this renders the same landing
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
    <AppShell
      title="New trip"
      rail={<Sidebar conversations={conversations} userEmail={user.email ?? null} />}
    >
      <Landing />
    </AppShell>
  )
}
