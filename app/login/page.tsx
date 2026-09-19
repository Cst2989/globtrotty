'use client'

import { useState, type FormEvent } from 'react'
import { createBrowserSupabase } from '@/web/supabase/browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const supabase = createBrowserSupabase()
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })

    setPending(false)

    if (signInError) {
      setError(signInError.message)
      return
    }

    setSent(true)
  }

  if (sent) {
    return (
      <div>
        <h1>Check your email</h1>
        <p>We sent a sign-in link to {email}. Open it on this device to continue.</p>
      </div>
    )
  }

  return (
    <div>
      <h1>Sign in to Globetrotty</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send magic link'}
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
