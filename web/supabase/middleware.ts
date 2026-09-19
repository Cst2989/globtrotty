import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Paths reachable with no session. `/login` (the sign-in form) and
// `/auth/callback` (the magic-link redirect target, which establishes the
// session) must both be reachable before a user exists.
const PUBLIC_PATHS = ['/login', '/auth/callback']

// Netlify's own function paths (`/.netlify/functions/*`) carry the worker's
// shared-secret header, never a session; the function checks it itself. The
// `proxy.ts` matcher already skips them — this keeps the pure decision honest
// if the matcher ever regresses.
const WORKER_PREFIX = '/.netlify/'

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith(WORKER_PREFIX)) return true
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export type SessionDecision = 'next' | 'redirect' | '401'

/**
 * Pure decision function, extracted (fix round 1, Important) so the three
 * outcomes are unit-testable without a real `NextRequest`/Supabase call:
 * - a user, or a public path: let the request through.
 * - no user, an API route (`/api/...`): a fetch call has nowhere useful to
 *   follow a redirect to `/login` — respond 401 directly.
 * - no user, anything else: redirect to `/login`.
 */
export function decide(pathname: string, hasUser: boolean): SessionDecision {
  if (hasUser || isPublicPath(pathname)) return 'next'
  if (pathname.startsWith('/api/')) return '401'
  return 'redirect'
}

/**
 * Refreshes the Supabase session cookie on every request and redirects to
 * `/login` (or responds 401 for `/api/*`) when there is no authenticated
 * user and the path isn't public.
 *
 * Uses `getUser()`, never `getSession()`: `getSession()` reads the JWT out of
 * the cookie without verifying it against the Supabase Auth server, so a
 * stale or forged cookie would pass. `getUser()` round-trips to Auth and is
 * the only call that actually authenticates the request.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Do not add logic between `createServerClient` and `getUser()`: the call
  // itself performs the token refresh this middleware exists to run, and a
  // stray early return here would skip that refresh.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const decision = decide(request.nextUrl.pathname, Boolean(user))

  if (decision === '401') {
    // Same reasoning as the redirect branch below: `setAll` above may have
    // refreshed the session cookie onto `response` before the 401 decision
    // was reached, and a bare `new NextResponse(...)` here would drop that
    // write.
    const unauthorizedResponse = new NextResponse(null, { status: 401 })
    for (const cookie of response.cookies.getAll()) {
      unauthorizedResponse.cookies.set(cookie)
    }
    return unauthorizedResponse
  }

  if (decision === 'redirect') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    const redirectResponse = NextResponse.redirect(url)
    // Fix round 1 (Minor): `setAll` above may have refreshed the session
    // cookie onto `response`. Returning a fresh `NextResponse.redirect(...)`
    // would drop that cookie write; carry it onto the redirect instead so a
    // just-refreshed (but still unauthenticated, e.g. mid-sign-out) request
    // doesn't lose the update.
    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie)
    }
    return redirectResponse
  }

  return response
}
