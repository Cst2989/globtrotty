import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type postgres from 'postgres'
import { withUser, type RouteContext, type SessionUser } from '@/web/session'
import { readInvokeEnv } from '@/web/invoke'
import { ownerSql } from '@/src/db/owner'
import { invokeBackground } from '@/src/invoke'
import { submitAction } from '@/src/handler'
import { decideProposal, loadProposalForUser } from '@/src/repo/proposals'
import { DEFAULT_LIMITS } from '@/src/limits'
import type { ActionPayload } from '@/src/actions'

/**
 * `POST /api/proposals/[id]/decide`'s real logic — kept out of
 * `app/api/proposals/[id]/decide/route.ts` itself, same reason as
 * `web/messagesRoute.ts`'s `makePost`: a Route Handler file may export only
 * the recognised HTTP-method functions, and `next build`'s generated route
 * types reject anything else (confirmed for `makePost` in Task 7; the same
 * restriction applies here).
 *
 * `rejectReason`, when present, is never folded into the action row's JSON —
 * `src/actions.ts`'s `rejected` payload deliberately carries no `reason`
 * field. It travels as `submitAction`'s `userNote` instead, which stores it
 * as an ordinary `role = 'user'` message the model reads through the normal
 * transcript, in the SAME transaction as the action row.
 *
 * Fix round 1 (Task 8 review, Minor #7): `superRefine` rejects a
 * `rejectReason` sent alongside `decision: 'accept'` — a reason only makes
 * sense on a rejection, and silently ignoring it (the previous shape) would
 * let a client believe an accept-time note was recorded somewhere when
 * nothing downstream ever reads it.
 */
const Body = z.strictObject({
  decision: z.enum(['accept', 'reject']),
  rejectReason: z.string().min(1).max(2000).optional(),
}).superRefine((value, ctx) => {
  if (value.decision === 'accept' && value.rejectReason !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['rejectReason'], message: 'rejectReason is only valid with decision: "reject"' })
  }
})

export type DecideRouteDeps = {
  sql: postgres.Sql
  invoke: (turnId: string) => Promise<void>
}

/**
 * Builds the inner `(user, req, ctx)` handler `route.ts`'s `POST` wraps with
 * `withUser`. `test/web-api-proposals.test.ts` calls this directly with
 * `withTestDb`'s `sql`, a `vi.fn()` invoke, and a fixed session user.
 *
 * Ownership is checked EXPLICITLY on the owner connection
 * (`loadProposalForUser`) before `submitAction` ever runs — that function
 * runs on `deps.sql`, which bypasses RLS entirely, so without this lookup a
 * signed-in traveller could decide (or probe the existence of) any proposal
 * id by guessing uuids. A proposal that doesn't exist and one that exists
 * under someone else's account look identical here — 404 either way.
 *
 * Fix round 1 (Task 8 review, Critical): `decideProposal` is no longer
 * called ahead of `submitAction`. The original shape recorded the decision
 * FIRST and only then tried to win a fresh turn for the hand-off/rejected
 * action — a turn already in flight (`busy`) or the account's spend ceiling
 * (`limit_reached`) both fail AFTER the decision was already durable, which
 * left an accepted proposal with no hand-off turn, no buttons (the card
 * loses them once `decision` is set), and no way back once the cashier's
 * own 30-minute acceptance window (`src/tools/cashier.ts`) had since
 * expired. `decideProposal` now runs as `submitAction`'s `onFreshTurn` hook
 * — INSIDE the same transaction as the turn insert, after the turn is
 * actually won: a `busy`/`limit_reached` result never reaches it at all, and
 * an "already decided" throw rolls the turn insert back with it, surfacing
 * to this route as a rejected promise it maps to 409.
 */
export function makeDecide(deps: DecideRouteDeps) {
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

    const action: ActionPayload = parsed.data.decision === 'accept'
      ? { action: 'hand_off', proposalId }
      : { action: 'rejected', proposalId }

    // `decideProposal` throws on not-found (impossible here, already scoped
    // above) or already-decided — thrown from inside `onFreshTurn`, which
    // rolls the whole transaction back (the fresh turn included) and
    // rejects this call. A second decide lands here as 409, per the
    // brief's own test ("second decide → 409") — now via this catch rather
    // than a standalone `decideProposal` call ahead of `submitAction`.
    try {
      const result = await submitAction(
        { sql: deps.sql, limits: DEFAULT_LIMITS, invoke: deps.invoke },
        {
          userId: user.id,
          conversationId: proposal.conversationId,
          action,
          idempotencyKey: randomUUID(),
          userNote: parsed.data.decision === 'reject' ? parsed.data.rejectReason : undefined,
          onFreshTurn: (tx) => decideProposal(tx, {
            proposalId,
            conversationId: proposal.conversationId,
            decision: parsed.data.decision,
            rejectReason: parsed.data.decision === 'reject' ? parsed.data.rejectReason ?? null : null,
          }),
        },
      )

      if (result.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 409 })
      if (result.status === 'limit_reached') return NextResponse.json({ error: 'limit_reached' }, { status: 429 })
      return NextResponse.json({ turnId: result.turnId })
    } catch {
      return NextResponse.json({ error: 'already_decided' }, { status: 409 })
    }
  }
}

// Lazy, same reasoning as `web/messagesRoute.ts`'s `liveDeps`: `ownerSql()`/
// `readInvokeEnv()` throw when their env var is unset, and calling them here
// (inside the function `withUser` invokes per request) keeps that failure at
// the first request after a misconfigured deploy, not at build time.
function liveDeps(): DecideRouteDeps {
  return { sql: ownerSql(), invoke: invokeBackground(readInvokeEnv()) }
}

export const postDecide = withUser((user, req, ctx) => makeDecide(liveDeps())(user, req, ctx))
