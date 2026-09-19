import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

/**
 * Server Components and Route Handlers. Reads/writes cookies via `cookies()`;
 * a `setAll` call from a Server Component (which cannot set cookies) is
 * swallowed because the middleware's `updateSession` is what actually
 * refreshes the session cookie on every request — see
 * `web/supabase/middleware.ts`.
 */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component; middleware refreshes the
            // session cookie on the next request instead.
          }
        },
      },
    },
  )
}
