'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SignOut } from '@phosphor-icons/react'
import { createBrowserSupabase } from '@/web/supabase/browser'

/** Ends the Supabase session in the browser, then lands on `/login`. */
export function SignOutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function handleClick() {
    setPending(true)
    const supabase = createBrowserSupabase()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      aria-label="Sign out"
      title="Sign out"
      disabled={pending}
      onClick={handleClick}
    >
      <SignOut size={18} />
    </button>
  )
}
