'use client'

import { useState, type FormEvent } from 'react'
import { EnvelopeSimpleOpen } from '@phosphor-icons/react'
import { createBrowserSupabase } from '@/web/supabase/browser'

export function LoginForm() {
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
      <div className="login-sent" role="status">
        <EnvelopeSimpleOpen size={36} weight="duotone" aria-hidden="true" />
        <h2>Check your email</h2>
        <p>
          A sign-in link is on its way to <strong>{email}</strong>. Open it on this device to
          continue.
        </p>
        <p className="note">
          Nothing arrived after a minute? Check spam, or{' '}
          <button type="button" className="link-button" onClick={() => setSent(false)}>
            send it again
          </button>
          .
        </p>
      </div>
    )
  }

  return (
    <>
      <div>
        <h2>Sign in</h2>
        <p>Enter your email and we send a one-time link. No password to remember.</p>
      </div>
      <form onSubmit={handleSubmit} className="field">
        <label htmlFor="email" className="field-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Sending link' : 'Send sign-in link'}
        </button>
      </form>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
