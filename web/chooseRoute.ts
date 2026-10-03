import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type postgres from 'postgres'
import { withUser, type RouteContext, type SessionUser } from '@/web/session'
import { readInvokeEnv } from '@/web/invoke'
import { ownerSql } from '@/src/db/owner'
import { invokeBackground } from '@/src/invoke'
import { ActionRefused, submitAction } from '@/src/handler'
import { DEFAULT_LIMITS } from '@/src/limits'

/**
 * `POST /api/conversations/[id]/choose`'s real logic — kept out of
 * `app/api/conversations/[id]/choose/route.ts` itself, same reason
 * `web/messagesRoute.ts`'s `makePost` is kept out of its own route file.
 *
 * Unlike `web/decideRoute.ts`/`web/reviseRoute.ts` (whose `[id]` names a
 * PROPOSAL, checked via `loadProposalForUser`), this route's `[id]` is the
 * CONVERSATION itself — a `choose` card is pressed against a `results` row,
 * which names no proposal yet. Ownership is checked the same way
 * `web/messagesRoute.ts`'s `makePost` checks a conversation id: an explicit
 * `select 1 from conversations where id = … and user_id = …` on the owner
 * connection, which bypasses RLS and so cannot be trusted to refuse on its
 * own. A conversation that doesn't exist and one that exists under someone
 * else's account look identical here — 404 either way.
 */
const Body = z.strictObject({
  kind: z.enum(['flight', 'hotel']),
  sourceId: z.string().min(1).max(512),
})

export type ChooseRouteDeps = {
  sql: postgres.Sql
  invoke: (turnId: string) => Promise<void>
}

/**
 * Builds the inner `(user, req, ctx)` handler `route.ts`'s `POST` wraps with
 * `withUser`. `test/web-api-choose.test.ts` calls this directly with
 * `withTestDb`'s `sql`, a `vi.fn()` invoke, and a fixed session user.
 *
 * The corpus pre-check (`tool_results`, scoped to this conversation AND the
 * claimed kind) runs before `submitAction` ever writes the action row — same
 * reasoning as `web/reviseRoute.ts`'s own swap-sourceId check: without it, a
 * `sourceId` from another conversation, or one of the wrong kind for the
 * claimed button, would reach `handleChoose` (src/agents/choose.ts) a whole
 * turn later, having already spent a turn (and the model/reviewer money
 * inside it) discovering the id does not resolve to anything useful.
 */
export function makeChoose(deps: ChooseRouteDeps) {
  return async (user: SessionUser, req: Request, ctx: RouteContext): Promise<Response> => {
    const params = await ctx.params
    const idCheck = z.uuid().safeParse(params.id)
    if (!idCheck.success) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const conversationId = idCheck.data

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

    const owned = await deps.sql`
      select 1 from conversations where id = ${conversationId} and user_id = ${user.id}`
    if (owned.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const corpus = await deps.sql`
      select 1 from tool_results
       where conversation_id = ${conversationId}
         and source_id = ${parsed.data.sourceId}
         and kind = ${parsed.data.kind}`
    if (corpus.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    try {
      const result = await submitAction(
        { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
        {
          userId: user.id,
          conversationId,
          action: { action: 'choose', kind: parsed.data.kind, sourceId: parsed.data.sourceId },
          idempotencyKey: randomUUID(),
        },
      )

      if (result.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 409 })
      if (result.status === 'limit_reached') return NextResponse.json({ error: 'limit_reached' }, { status: 429 })
      return NextResponse.json({ ok: true })
    } catch (err) {
      // Spec §4: "the routes assert `desk = 'planning'` and `409` otherwise."
      // Same narrow catch as `web/decideRoute.ts`/`web/reviseRoute.ts` —
      // only `ActionRefused` maps to 409 here; anything else propagates to
      // `withUser`'s own 500 rather than being folded into a misleading one.
      if (err instanceof ActionRefused) {
        return NextResponse.json({ error: 'not_planning' }, { status: 409 })
      }
      throw err
    }
  }
}

// Lazy, same reasoning as `web/messagesRoute.ts`'s `liveDeps`: `ownerSql()`/
// `readInvokeEnv()` throw when their env var is unset, and calling them here
// (inside the function `withUser` invokes per request) keeps that failure at
// the first request after a misconfigured deploy, not at build time.
function liveDeps(): ChooseRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postChoose = withUser((user, req, ctx) => makeChoose(liveDeps())(user, req, ctx))
