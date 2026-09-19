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
 *
 * Fix round 1 (Important): a non-`'new'` id is now checked two ways before
 * `submitMessage` ever runs. First, it must be a real uuid (`z.uuid()`) — a
 * malformed id is a 404, the same as one that doesn't exist. Second, an
 * explicit `select 1 from conversations where id = … and user_id = …` on the
 * owner connection confirms SHE owns it. Neither check is optional:
 * `submitMessage` (`src/handler.ts`) runs on `deps.sql`, the owner Postgres
 * connection, which bypasses RLS entirely — see `src/db/owner.ts`'s doc
 * comment. `submitMessage` does read `input.userId` in its own queries (the
 * spend read, the `update … where … and user_id = …` guards), but those are
 * DATA filters, not an authorisation check: nothing inside `submitMessage`
 * ever refuses to act just because the conversation belongs to someone
 * else — it would, for instance, happily insert a `messages` row under a
 * foreign `conversation_id` (the FK only requires that `(id, user_id)` pair
 * to exist for SOME user, not this one) or silently update zero rows and
 * still report success. Without this lookup, a signed-in traveller could
 * write into or probe the existence of any conversation id by guessing
 * uuids. A conversation that doesn't exist and one that exists under
 * someone else's account are made to look identical here — 404 either way.
 */
export function makePost(deps: MessagesRouteDeps) {
  return async (user: SessionUser, req: Request, ctx: RouteContext): Promise<Response> => {
    const params = await ctx.params
    const rawId = params.id

    let conversationId: string | null
    if (rawId === 'new') {
      conversationId = null
    } else {
      const idCheck = z.uuid().safeParse(rawId)
      if (!idCheck.success) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
      conversationId = idCheck.data

      const owned = await deps.sql`
        select 1 from conversations where id = ${conversationId} and user_id = ${user.id}`
      if (owned.length === 0) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
    }

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
