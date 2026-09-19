import { NextResponse } from 'next/server'
import { createServerSupabase } from './supabase/server.js'

export type SessionUser = { id: string; email: string | null }

/**
 * Route-handler guard: resolves the verified session user or throws
 * `UnauthorizedError`. Uses `getUser()` (never `getSession()`) for the same
 * reason `web/supabase/middleware.ts` does — it verifies the JWT against
 * Supabase Auth instead of trusting an unverified cookie.
 *
 * Fix round 1 (plan 4a, Task 6 review, Critical): the original contract threw
 * a `NextResponse` object directly. Next does not treat a thrown `Response`
 * specially — an uncaught throw of any kind becomes a 500 in the framework's
 * own error boundary, verified against the installed Next 16 runtime, so a
 * caller that forgot to catch got exactly the wrong status code. `requireUser`
 * now throws a real `Error` subclass instead; `withUser` below is the one
 * place that turns it into the actual 401 response, so every route handler
 * gets the right status without re-implementing the catch.
 */
export class UnauthorizedError extends Error {
  readonly status = 401
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export async function requireUser(): Promise<SessionUser> {
  const supabase = await createServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new UnauthorizedError()
  }

  return { id: user.id, email: user.email ?? null }
}

/**
 * Route Handler params, as Next's App Router passes them (its own generated
 * `RouteContext<Route>` is parameterised per-route and only exists after
 * `next build`/`next dev` has generated `.next/types`; this local, unparameterised
 * shape is enough for a route-agnostic wrapper like `withUser`).
 */
export type RouteContext = { params: Promise<Record<string, string>> }

/**
 * Wraps a Route Handler so every authenticated route is
 * `export const POST = withUser(async (user, req, ctx) => ...)`: `fn` only
 * runs once `requireUser()` has resolved a real session user, and an
 * `UnauthorizedError` — and only that error — becomes the 401 JSON response.
 * Any other error (a bug, a DB failure) is rethrown rather than swallowed
 * into a misleading 401; a leaked `UnauthorizedError` reaching a caller is at
 * least a real `Error`, not a silently-500'd `Response`.
 */
export function withUser(
  fn: (user: SessionUser, req: Request, ctx: RouteContext) => Promise<Response>,
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    let user: SessionUser
    try {
      user = await requireUser()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
      }
      throw err
    }
    return fn(user, req, ctx)
  }
}
