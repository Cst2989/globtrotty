import { NextResponse } from 'next/server'
import { createServerSupabase } from './supabase/server'

/**
 * Route-handler guard: resolves the verified session user or throws a
 * 401 `NextResponse`. Uses `getUser()` (never `getSession()`) for the same
 * reason `web/supabase/middleware.ts` does — it verifies the JWT against
 * Supabase Auth instead of trusting an unverified cookie.
 *
 * Throwing (rather than returning `null`) keeps callers from having to
 * remember to check for an absent user on every call; a route handler that
 * forgets to `catch` simply lets the 401 propagate, which is the correct
 * default.
 */
export async function requireUser(): Promise<{ id: string; email: string | null }> {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new NextResponse('Unauthorized', { status: 401 })
  }

  return { id: user.id, email: user.email ?? null }
}
