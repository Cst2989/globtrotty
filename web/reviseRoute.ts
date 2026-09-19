import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type postgres from 'postgres'
import { withUser, type RouteContext, type SessionUser } from '@/web/session'
import { readInvokeEnv } from '@/web/invoke'
import { ownerSql } from '@/src/db/owner'
import { invokeBackground } from '@/src/invoke'
import { submitAction } from '@/src/handler'
import { loadProposalForUser } from '@/src/repo/proposals'
import { DEFAULT_LIMITS } from '@/src/limits'
import { SLOT_NAMES } from '@/src/gates/rehydrateGate'

/**
 * `POST /api/proposals/[id]/revise`'s real logic — kept out of
 * `app/api/proposals/[id]/revise/route.ts` for the same reason
 * `web/decideRoute.ts`'s `makeDecide` is kept out of its own route file.
 *
 * Deliberately the same shape as `src/actions.ts`'s `ActionPayload`'s
 * `revise` arm's `change` field (a `swap` with a slot from the closed
 * `SLOT_NAMES` vocabulary and a `sourceId`, or a `shift` of exactly ±2 days) —
 * this is the request BODY, not the action row, so it has no `action` or
 * `proposalId` wrapper; the two schemas are kept separate (rather than
 * imported from one another) because they validate different things at
 * different trust boundaries: this one is "what may a browser POST here",
 * `ActionPayload`'s is "what may a `messages` row ever contain".
 */
const Body = z.union([
  z.strictObject({
    kind: z.literal('swap'), slot: z.enum(SLOT_NAMES), sourceId: z.string().min(1).max(512),
  }),
  z.strictObject({ kind: z.literal('shift'), days: z.union([z.literal(-2), z.literal(2)]) }),
])

export type ReviseRouteDeps = {
  sql: postgres.Sql
  invoke: (turnId: string) => Promise<void>
}

/**
 * Builds the inner `(user, req, ctx)` handler `route.ts`'s `POST` wraps with
 * `withUser`. Same ownership check as `web/decideRoute.ts`'s `makeDecide`:
 * `loadProposalForUser` on the owner connection, before `submitAction` ever
 * runs — a proposal id from another traveller's account 404s, never 500s or
 * silently acts.
 */
export function makeRevise(deps: ReviseRouteDeps) {
  return async (user: SessionUser, req: Request, ctx: RouteContext): Promise<Response> => {
    const params = await ctx.params
    const idCheck = z.uuid().safeParse(params.id)
    if (!idCheck.success) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const proposalId = idCheck.data

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

    const proposal = await loadProposalForUser(deps.sql, proposalId, user.id)
    if (!proposal) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const result = await submitAction(
      { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
      {
        userId: user.id,
        conversationId: proposal.conversationId,
        action: { action: 'revise', proposalId, change: parsed.data },
        idempotencyKey: randomUUID(),
      },
    )

    if (result.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 409 })
    if (result.status === 'limit_reached') return NextResponse.json({ error: 'limit_reached' }, { status: 429 })
    return NextResponse.json({ turnId: result.turnId })
  }
}

function liveDeps(): ReviseRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postRevise = withUser((user, req, ctx) => makeRevise(liveDeps())(user, req, ctx))
