import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type postgres from 'postgres'
import { withUser, type RouteContext, type SessionUser } from '@/web/session'
import { readInvokeEnv } from '@/web/invoke'
import { ownerSql } from '@/src/db/owner'
import { invokeBackground } from '@/src/invoke'
import { ActionRefused, submitAction } from '@/src/handler'
import { loadProposalForUser } from '@/src/repo/proposals'
import { DEFAULT_LIMITS } from '@/src/limits'
import { SLOT_NAMES } from '@/src/gates/rehydrateGate'
import { SLOT_KINDS } from '@/src/gates/checks'

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
 *
 * Fix round 1 (Task 8 review, Important #3): a `swap`'s `sourceId` is
 * checked against `tool_results` (owner connection, scoped to THIS
 * conversation and the slot's own kind) before `submitAction` ever runs —
 * without this, the card could hand the model a `revise_component` call
 * naming a `sourceId` that either belongs to another conversation entirely
 * or is the wrong kind for the slot (a hotel id for `outbound`), which
 * `buildRevisedRefs` (`src/tools/revise.ts`) has no way to catch until the
 * NEXT gate run — by which point a whole turn (and a model call) has
 * already been spent discovering it. 404 here, matching every other
 * "does this id exist for you" check in these two routes.
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

    if (parsed.data.kind === 'swap') {
      const wantKind = SLOT_KINDS[parsed.data.slot]
      const corpus = await deps.sql`
        select 1 from tool_results
         where conversation_id = ${proposal.conversationId}
           and source_id = ${parsed.data.sourceId}
           and kind = ${wantKind}`
      if (corpus.length === 0) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
    }

    // Final review, I3. Spec §4: "the routes assert `desk = 'planning'` and
    // `409` otherwise." `submitAction` throws `ActionRefused` when the
    // conversation is still at the front desk; this route had no catch at all,
    // so that surfaced as a framework 500. Only `ActionRefused` is caught —
    // anything else still propagates to `withUser`'s 500, which is what an
    // unexpected failure should be. Unreachable today (`desk` is monotonic and
    // `src/repo/conversations.ts` is its only writer): a contract gap, not a
    // live bug.
    let result
    try {
      result = await submitAction(
        { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
        {
          userId: user.id,
          conversationId: proposal.conversationId,
          action: { action: 'revise', proposalId, change: parsed.data },
          idempotencyKey: randomUUID(),
        },
      )
    } catch (err) {
      if (err instanceof ActionRefused) {
        return NextResponse.json({ error: 'not_planning' }, { status: 409 })
      }
      throw err
    }

    if (result.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 409 })
    if (result.status === 'limit_reached') return NextResponse.json({ error: 'limit_reached' }, { status: 429 })
    return NextResponse.json({ turnId: result.turnId })
  }
}

function liveDeps(): ReviseRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postRevise = withUser((user, req, ctx) => makeRevise(liveDeps())(user, req, ctx))
