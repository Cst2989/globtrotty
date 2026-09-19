import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabase } from '@/web/supabase/server'

/**
 * Fixed set of `/login?error=` codes `app/login/page.tsx` knows how to
 * render (fix round 1, Minor: a Supabase `error_description` is free-text
 * and must never be echoed to the page verbatim).
 */
export type LoginErrorCode = 'expired' | 'invalid' | 'unknown'

/** Magic-link redirect target: exchanges the OTP `code` for a session cookie, then sends the user home. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const code = params.get('code')
  const authError = params.get('error')
  const authErrorCode = params.get('error_code')

  const failure = (loginError: LoginErrorCode) => {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('error', loginError)
    return NextResponse.redirect(loginUrl)
  }

  // Supabase itself can redirect straight here with `error`/`error_code`/
  // `error_description` query params (e.g. a link opened after it expired)
  // instead of a `code` — no exchange to attempt in that case.
  if (authError || authErrorCode) {
    return failure(authErrorCode === 'otp_expired' ? 'expired' : 'invalid')
  }

  if (!code) {
    return failure('unknown')
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return failure('invalid')
  }

  return NextResponse.redirect(new URL('/', request.url))
}
