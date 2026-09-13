import type postgres from 'postgres'
import { constraintsFromNotebook } from '../gates/notebookConstraints.js'
import { runGates } from '../gates/pipeline.js'
import type { GateOutcome } from '../gates/types.js'
import { loadNotebook } from '../repo/notebook.js'
import { loadProposal } from '../repo/proposals.js'

export type ReplayResult = { outcome: GateOutcome; against: 'snapshot' | 'live' }

/**
 * Runs the gates again over a proposal that already exists, against the
 * notebook that proposal was judged with.
 *
 * `against: 'live'` exists so a lesson and a test can produce the wrong answer
 * on purpose and show what it looks like. It is never the default and no
 * production path passes it: reading the live notebook is what makes a replay
 * agree with whatever she believes today rather than with what we did.
 *
 * `proposalId` and `round` are passed through to `runGates`, which has accepted
 * both since lesson 4.5 and has never been given either, because
 * `proposalRunner` records the proposal AFTER the gates return. A replay runs
 * against a proposal that already exists, so it can name it, and
 * `gate_results_by_proposal` (migration 0013) finally indexes a column
 * something writes. The production path still writes null there and that is
 * correct: at the moment the production gates run, the row they would name does
 * not exist.
 *
 * `round` defaults to 1 rather than to 0 for the same reason: round 0 is the
 * verdict production reached, and a replay that overwrote that number would
 * make the two runs indistinguishable in the table they both write to.
 */
export async function replayGates(
  sql: postgres.Sql,
  args: {
    proposalId: string; conversationId: string; userId: string
    now: Date; today: string; round?: number; against?: 'snapshot' | 'live'
  },
): Promise<ReplayResult> {
  const proposal = await loadProposal(sql, args.proposalId, args.conversationId)
  if (!proposal) {
    throw new Error(`replayGates: no proposal ${args.proposalId} in conversation ${args.conversationId}`)
  }
  const against = args.against ?? 'snapshot'
  const nb = against === 'live'
    ? await loadNotebook(sql, args.conversationId, args.userId)
    : proposal.requirementsSnapshot
  if (!nb) {
    // Refused rather than fallen back to the live notebook. A fallback would
    // turn every pre-0018 row into a silently wrong pass, which is the failure
    // this file exists to remove, so the eval drops the case and the scorecard
    // counts it in `casesExpected` and not in `casesGraded`.
    throw new Error(
      `replayGates: proposal ${args.proposalId} was written before migration 0018 and carries `
      + 'no requirements snapshot. It cannot be replayed, and the live notebook is not a substitute.',
    )
  }
  const outcome = await runGates(sql, {
    conversationId: args.conversationId,
    userId: args.userId,
    turnId: proposal.turnId,
    refs: proposal.refs,
    notebook: constraintsFromNotebook(nb, args.today),
    now: args.now,
    proposalId: args.proposalId,
    round: args.round ?? 1,
  })
  return { outcome, against }
}
