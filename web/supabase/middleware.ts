import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Paths reachable with no session. `/login` (the sign-in form) and
// `/auth/callback` (the magic-link redirect target, which establishes the
// session) must both be reachable before a user exists.
const PUBLIC_PATHS = ['/login', '/auth/callback']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Refreshes the Supabase session cookie on every request and redirects to
 * `/login` when there is no authenticated user and the path isn't public.
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

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}
