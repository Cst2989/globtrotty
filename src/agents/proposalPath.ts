import { constraintsFromNotebook, runGates } from '../gates/pipeline.js'
import { countReviewerVerdicts } from '../repo/gateResults.js'
import { saveProposal, type GateOutcomeLabel } from '../repo/proposals.js'
import { SEATS } from '../model/seats.js'
import { formatMoney } from '../money.js'
import { maskUntrustedText, sanitizeSourceId } from '../sanitize.js'
import { MAX_REVIEW_ROUNDS, reviewOffer, type ReviewDeps } from './reviewer.js'
import type { Notebook } from '../notebook.js'

export type ProposalPathDeps = ReviewDeps

/**
 * Spec section 5, as one function shared by `propose_itinerary` and
 * `revise_component`: gates, then the reviewer, then the row. Returns the text
 * the MODEL reads; nothing here is shown to her directly.
 *
 * `spent` is the tool step's accumulator (src/worker.ts): the reviewer's Opus
 * call is debited by reviewOffer through reserve/reconcile, and this is how the
 * turn total learns of it. It is never passed to recordSpend.
 *
 * `round` is the caller's — derived from tool_calls by countPriorGateRuns — and
 * is what keeps the seven-plus-one gate rows unique per turn (migration 0013).
 */
export async function runProposalPath(
  deps: ProposalPathDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  spent: { micros: bigint },
  args: { refs: unknown; notebook: Notebook; round: number; parentProposalId: string | null },
): Promise<string> {
  const outcome = await runGates(deps.sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, refs: args.refs,
    notebook: constraintsFromNotebook(args.notebook), now: new Date(deps.now()), round: args.round,
  })
  if (!outcome.ok) {
    return 'The proposal was rejected. Fix exactly these and propose again:\n'
      + outcome.violations
          .map((v) => `- ${v.gate} (${v.sourceIds.map(sanitizeSourceId).join(', ') || 'no ids'}): ${v.detail}`)
          .join('\n')
  }

  const priorVerdicts = await countReviewerVerdicts(deps.sql, ctx.turnId)
  const review = await reviewOffer(deps, ctx, { items: outcome.items, total: outcome.total, notebook: args.notebook, round: args.round })
  spent.micros += review.costMicros

  let gateOutcome: GateOutcomeLabel
  let issues: string[]
  if (review.kind === 'skipped_limit') {
    gateOutcome = 'shipped_unapproved'
    issues = ['reviewer skipped: spending limit reached']
  } else if (review.verdict.approved) {
    gateOutcome = 'approved'
    issues = []
  } else if (priorVerdicts < MAX_REVIEW_ROUNDS) {
    // Below the bound: no row. The model fixes what the reviewer named and
    // proposes again, which is the next round.
    // F3: the reviewer's issues are text a MODEL (Opus, the reviewer seat)
    // wrote — untrusted the same way any model/supplier output is, and headed
    // straight into the driver's own context. maskUntrustedText strips control
    // characters (a raw newline included) before this joins them, so an
    // issue engineered to look like a new instruction line cannot fence.
    return `Revise: ${review.verdict.issues.map(maskUntrustedText).join('; ')}`
  } else {
    gateOutcome = 'shipped_unapproved'
    issues = review.verdict.issues
  }

  const reviewRounds = review.kind === 'skipped_limit' ? priorVerdicts : priorVerdicts + 1
  const proposalId = await saveProposal(deps.sql, {
    conversationId: ctx.conversationId, userId: ctx.userId, turnId: ctx.turnId, round: args.round,
    items: outcome.items, total: outcome.total, notebook: args.notebook,
    gateOutcome, reviewRounds, reviewIssues: issues,
    promptVersion: SEATS.driver.promptVersion, modelConfigId: SEATS.driver.modelConfigId,
    parentProposalId: args.parentProposalId,
  })
  const ids = outcome.items.map((i) => sanitizeSourceId(i.item.sourceId)).join(', ')
  const head = `Saved as proposal_id ${proposalId}. Total ${formatMoney(outcome.total)}. Items: ${ids}.`
  if (gateOutcome === 'approved') {
    return `${head} The reviewer approved it. Tell her what you chose and why, and that she can accept it or ask for a component to change.`
  }
  // Same masking as the Revise: reply above, for the same reason: `issues`
  // here is either the reviewer's own text or the fixed "skipped: spending
  // limit reached" string — never assume the former is safe to interpolate raw.
  return `${head} The reviewer has NOT approved it and the rounds are used up: ${issues.map(maskUntrustedText).join('; ')}. `
       + 'Tell her what you chose, and pass on the reviewer\'s concerns in her words — she decides.'
}
