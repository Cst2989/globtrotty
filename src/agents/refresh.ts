/**
 * "Refresh prices". A `refresh` action (src/actions.ts) is written when she presses the small
 * `Refresh prices` link the results pane puts in the bar above a list whose prices have aged out
 * — `handleRefresh` runs as the agent for the fresh turn `submitAction` queued for it
 * (src/agents/router.ts dispatches a newest-row `refresh` action here, never to the driver).
 *
 * It re-runs the search she already had, nothing more. WHAT to re-run is `planFor`
 * (src/agents/research.ts) rather than this file's own reading of a stored row: a hotels plan
 * comes from the chosen flight's own destination and window, because a `results` row written
 * before the airport-to-metro fix says `NRT`, and rebuilding from it searched SearchApi for
 * "NRT" — which is how a list of Tokyo hotels came back as vacation rentals in the United
 * States. The supplier call goes through the same budget/begin/finish/record door as
 * `src/agents/intake.ts`'s, both kinds are re-ranked by Jev so the new row carries verdicts and
 * does not render under "Not checked against your request", and the reply carries a fresh
 * `results` attachment. Nothing about the trip is re-interpreted, so there is no intake Jev call
 * here and no notebook write: a price refresh is not a new brief.
 *
 * Polish pass, section 2 (the author's ruling): this no longer runs by itself. Opening a
 * conversation used to fire one of these per aged-out row from an effect in the results pane,
 * which meant navigating between chats started turns, wrote "You asked to refresh prices" into
 * the thread, and left price skeletons standing over a list it had not managed to replace. Only
 * her own press reaches here now.
 *
 * Trust boundary: every sentence below is fixed English chosen by this file or by
 * src/agents/stage.ts. A stored query supplies codes and ISO dates to the SUPPLIER, never a word
 * of prose to her or to the model.
 */
import type { AgentContext, AgentStep } from '../worker.js'
import type { IntakeDeps } from './intake.js'
import { nextStepsAttachment } from './nextSteps.js'
import { recordSpend } from '../repo/spend.js'
import { ResearchSupplierError, planFor, rerunSearch, resultsAttachment } from './research.js'
import { conversationStage, nextStepsForList, refreshReplyFor } from './stage.js'

/** The router's own shape for a `refresh` action; `action` has already done its job by now. */
export type RefreshAction = { kind: 'flight' | 'hotel' }

/** No stored search of that kind to re-run — a forged or very stale press. Costs nothing to refuse. */
const NOTHING_TO_REFRESH = 'I do not have a search to refresh. Tell me the trip again.'

/**
 * A search that worked a quarter of an hour ago and comes back empty now is almost always a
 * transient supplier answer, so the words point at the two things that actually help rather
 * than at a problem she caused.
 */
const ZERO_ITEMS = 'Nothing came back this time. Try again in a minute or change the dates.'

const SUPPLIER_FAILED = 'I could not reach the search just now. Please try again in a moment.'
const OTHER_FAILED = 'Something went wrong while refreshing those prices. Please try again.'

export async function handleRefresh(
  deps: IntakeDeps, ctx: AgentContext, action: RefreshAction,
): Promise<AgentStep> {
  const { sql } = deps
  const plan = await planFor(deps, ctx, action.kind)
  if (!plan) return { kind: 'park', message: NOTHING_TO_REFRESH, costMicros: 0n }

  const stage = await conversationStage(sql, ctx.conversationId, ctx.userId)

  let cost = 0n
  try {
    const callId = action.kind === 'flight' ? 'refresh-flights' : 'refresh-hotels'
    const run = await rerunSearch(deps, ctx, plan, callId)
    if (run.status === 'budget') {
      return {
        kind: 'fail', reason: 'limit_reached',
        message: `You have used all ${run.max} supplier searches for this turn `
          + `(${run.used} so far). Please try again in a moment.`,
        recordedMicros: 0n,
      }
    }
    cost += run.cost
    if (run.status === 'zero') {
      return {
        kind: 'park', message: ZERO_ITEMS, costMicros: cost,
        attachments: [nextStepsAttachment(action.kind === 'flight' ? 'zero_flights' : 'zero_hotels')],
      }
    }

    // Section 8b: what the desk says about a refresh follows the STAGE, not the button. A
    // flights refresh while she is choosing a hotel is bookkeeping, and `refreshReplyFor`
    // returns an empty string for it — the new row still lands, silently, which is the whole
    // point. Chips go with the SENTENCE, never on their own: a bare chip group under nothing is
    // the office talking to itself.
    const message = refreshReplyFor(stage, plan.rowKind)
    const results = resultsAttachment(plan, run, { refreshed: true, limit: 10 })
    return {
      kind: 'park',
      message,
      costMicros: cost,
      attachments: message === ''
        ? [results]
        : [results, nextStepsAttachment(nextStepsForList(stage, plan.rowKind))],
    }
  } catch (err) {
    // Same hand-debit as `runIntakeTurn`'s catch: a `fail` step carries no `costMicros` for the
    // worker to debit, so whatever the re-rank call has cost so far is debited here, once.
    await recordSpend(sql, { userId: ctx.userId, conversationId: ctx.conversationId, costMicros: cost })
    return {
      kind: 'fail',
      reason: err instanceof ResearchSupplierError ? 'provider_down' : 'fetch_failed',
      message: err instanceof ResearchSupplierError ? SUPPLIER_FAILED : OTHER_FAILED,
      recordedMicros: cost,
    }
  }
}
