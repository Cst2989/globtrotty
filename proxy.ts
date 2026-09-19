import type { NextRequest } from 'next/server'
import { updateSession } from './web/supabase/middleware'

// Next 16 deprecated the `middleware.ts` file convention in favour of
// `proxy.ts` (same behaviour, renamed file/export) — `next build` prints a
// deprecation warning under the old name, so this scaffold uses the current
// convention. The session-refresh logic itself lives in
// `web/supabase/middleware.ts`'s `updateSession`, unaffected by the rename.
export async function proxy(request: NextRequest) {
  return updateSession(request)
}

// `/.netlify/` is excluded: the background worker, the sweeper and the drift
// monitor live there and authenticate with `WORKER_SHARED_SECRET`, not a
// session cookie. Found in the plan-4a deploy smoke — with the default matcher
// the edge proxy answered the worker's POST with a 307 to `/login`, so no turn
// could ever start. `decide()` mirrors the exclusion as a second line.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|\\.netlify/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
