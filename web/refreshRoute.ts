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
 * `POST /api/conversations/[id]/refresh`'s real logic — kept out of
 * `app/api/conversations/[id]/refresh/route.ts` itself, same reason
 * `web/chooseRoute.ts`'s `makeChoose` is kept out of its own route file.
 *
 * A mirror of that route, one step simpler: `[id]` is the CONVERSATION
 * (ownership checked with an explicit `select 1 … and user_id = …` on the
 * owner connection, which bypasses RLS and so cannot be trusted to refuse on
 * its own — a conversation that does not exist and one under someone else's
 * account look identical here, 404 either way), and there is no corpus
 * pre-check to make because the body names no `sourceId`. It names a KIND and
 * nothing else; which row to re-run is found server-side by
 * `handleRefresh` (src/agents/refresh.ts) from the newest unfiltered
 * `results` row of that kind. A press with no such row costs one turn that
 * answers "I do not have a search to refresh", which is cheap and honest —
 * cheaper than a second read here that would have to duplicate that lookup.
 *
 * The body says `flights`/`hotels` — the vocabulary `ResultsContent.kind` and
 * the pane's own sections use, which is what the button has in hand — and the
 * ACTION says `flight`/`hotel`, the vocabulary every `ActionPayload` arm uses
 * (`choose`'s included). The mapping is the one line below rather than a new
 * spelling in either place.
 */
const Body = z.strictObject({ kind: z.enum(['flights', 'hotels']) })

const ACTION_KIND = { flights: 'flight', hotels: 'hotel' } as const

export type RefreshRouteDeps = {
  sql: postgres.Sql
  invoke: (turnId: string) => Promise<void>
}

/**
 * Builds the inner `(user, req, ctx)` handler `route.ts`'s `POST` wraps with
 * `withUser`. `test/web-api-refresh.test.ts` calls this directly with
 * `withTestDb`'s `sql`, a `vi.fn()` invoke, and a fixed session user.
 */
export function makeRefresh(deps: RefreshRouteDeps) {
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

    try {
      const result = await submitAction(
        { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
        {
          userId: user.id,
          conversationId,
          action: { action: 'refresh', kind: ACTION_KIND[parsed.data.kind] },
          idempotencyKey: randomUUID(),
        },
      )

      if (result.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 409 })
      if (result.status === 'limit_reached') return NextResponse.json({ error: 'limit_reached' }, { status: 429 })
      return NextResponse.json({ ok: true })
    } catch (err) {
      // Spec §4: "the routes assert `desk = 'planning'` and `409` otherwise."
      // Same narrow catch as every sibling route — only `ActionRefused` maps
      // to 409; anything else propagates to `withUser`'s own 500.
      if (err instanceof ActionRefused) {
        return NextResponse.json({ error: 'not_planning' }, { status: 409 })
      }
      throw err
    }
  }
}

// Lazy, same reasoning as `web/chooseRoute.ts`'s own `liveDeps`.
function liveDeps(): RefreshRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postRefresh = withUser((user, req, ctx) => makeRefresh(liveDeps())(user, req, ctx))
