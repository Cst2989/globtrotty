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

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
