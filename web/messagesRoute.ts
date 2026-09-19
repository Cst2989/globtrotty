import { NextResponse } from 'next/server'
import { z } from 'zod'
import type postgres from 'postgres'
import { withUser, type RouteContext, type SessionUser } from '@/web/session'
import { readInvokeEnv } from '@/web/invoke'
import { ownerSql } from '@/src/db/owner'
import { invokeBackground } from '@/src/invoke'
import { submitMessage } from '@/src/handler'
import { DEFAULT_LIMITS } from '@/src/limits'

/**
 * The `POST /api/conversations/[id]/messages` handler's real logic, kept out
 * of `app/api/conversations/[id]/messages/route.ts` itself: a Next Route
 * Handler file may export only the recognised HTTP-method functions and a
 * handful of special names — `next build`'s own generated route types reject
 * any other export (confirmed empirically: `makePost`/`MessagesRouteDeps`
 * living in `route.ts` failed Next's build-time type check with "Property
 * 'makePost' is incompatible with index signature ... type 'never'"). This
 * module has no such restriction, so `test/web-api-messages.test.ts` imports
 * `makePost` from here.
 */

// `strictObject`: an unexpected extra key — most notably `user_id` — is a
// 400, not a silently-dropped field. `userId` for `submitMessage` comes
// exclusively from the verified session (`withUser`'s `user` argument)
// below; there is no code path that reads it off the body at all, and this
// schema makes sure a body that tries anyway is refused outright rather than
// accepted-with-the-field-ignored.
const Body = z.strictObject({
  text: z.string().min(1).max(4000),
  idempotencyKey: z.string().min(8).max(64),
})

export type MessagesRouteDeps = {
  sql: postgres.Sql
  invoke: (turnId: string) => Promise<void>
}

/**
 * Builds the inner `(user, req, ctx)` handler `route.ts`'s `POST` wraps with
 * `withUser`. Kept separate (rather than inlined) so
 * `test/web-api-messages.test.ts` can call it directly with `withTestDb`'s
 * `sql`, a `vi.fn()` invoke, and a fixed session user — no need to mock
 * `web/session.ts` or spin up a real request; `withUser`'s own 401 contract
 * already has full coverage in test/web-session.test.ts.
 */
export function makePost(deps: MessagesRouteDeps) {
  return async (user: SessionUser, req: Request, ctx: RouteContext): Promise<Response> => {
    const params = await ctx.params
    const conversationId = params.id === 'new' ? null : (params.id ?? null)

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }

    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }

    const result = await submitMessage(
      { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
      {
        userId: user.id,
        conversationId,
        message: parsed.data.text,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    )

    const payload = { conversationId: result.conversationId, turnId: result.turnId, status: result.status }

    if (result.status === 'busy') return NextResponse.json(payload, { status: 409 })
    if (result.status === 'limit_reached') return NextResponse.json(payload, { status: 429 })
    return NextResponse.json(payload)
  }
}

// `ownerSql()`/`readInvokeEnv()` both throw when their env var is unset —
// exactly right for a request that actually needs them, wrong for module
// load time (which would throw at build). Calling them here, inside the
// function `withUser` invokes per request rather than at import, keeps that
// failure where it belongs: the first request after a misconfigured deploy,
// not the build itself. `ownerSql()` still only opens one connection —
// see its own doc comment for the `globalThis` cache that makes repeated
// calls cheap.
function liveDeps(): MessagesRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postMessages = withUser((user, req, ctx) => makePost(liveDeps())(user, req, ctx))
