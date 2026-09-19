import { redirect } from 'next/navigation'
import { createServerSupabase } from '@/web/supabase/server'

export default async function HomePage() {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  redirect(user ? '/c/new' : '/login')
}
