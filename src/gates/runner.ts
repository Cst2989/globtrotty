import type postgres from 'postgres'
import { formatMoney } from '../money.js'
import { recordProposal } from '../repo/proposals.js'
import { runGates } from './pipeline.js'
import type { NotebookConstraints } from './notebookConstraints.js'
import type { ToolRunner } from '../tools.js'

/**
 * Who the proposal belongs to, plus the two things the gates need that no id
 * carries.
 *
 * The three ids are spelled out here rather than taken as a `Claim`
 * (src/repo/turns.ts), which is what `corpusRunner` and `ledgerRunner` take.
 * Those two WRITE fenced, so they need the claim's `attempts` token; this one
 * writes `gate_results`, which is deliberately not fenced
 * (src/repo/gateResults.ts), and it has to accept `turnId: null` for a gate run
 * outside a turn. Asking for a Claim would demand a token nothing here uses and
 * refuse a null turn id the pipeline supports.
 */
export type ProposalContext = {
  conversationId: string
  userId: string
  turnId: string | null
  notebook: NotebookConstraints
  now: () => Date
}

/**
 * The `propose_itinerary` link of the runner chain, composed outside
 * `corpusRunner` and inside `cashierRunner` (lesson 4.6), which is itself
 * inside `ledgerRunner`:
 *
 *   doorRunner('planning',
 *     ledgerRunner(sql, claim,
 *       notebookRunner(sql, ctx,
 *         scoutRunner(sql, ctx,
 *           cardRunner(sql, ctx,
 *             escalationRunner(sql, ctx,
 *               cashierRunner(sql, ctx, deps,
 *                 proposalRunner(sql, ctx,
 *                   corpusRunner(sql, claim,
 *                     supplierRunner(suppliers, ctx.notebook.currency))))))))))
 *
 * Outside the corpus because a proposal is judged against what the corpus
 * already holds and writes nothing to it. Inside the ledger because a replayed
 * proposal is correct, and running the gates twice against the same corpus at
 * the same instant produces the same verdict anyway. Inside the cashier because
 * the hand-off re-quotes a proposal this link has already judged. Every other
 * tool name falls through to `inner`, so each layer knows exactly one thing.
 *
 * That is netlify/functions/run-turn-background.mts, nine wrappers around
 * `supplierRunner`, outermost first. `npm run trip` (scripts/trip.ts) builds the
 * same chain minus `ledgerRunner`, which is EIGHT wrappers, cashier included,
 * since it is one process with no crash to resume from. It is not free to drop
 * THIS one: both drivers send the planning desk's tools, so a chain without this
 * link advertises `propose_itinerary` and then answers the model "Unknown tool
 * propose_itinerary" out of `supplierRunner`, and a chain without the cashier
 * link answers the same way for `hand_off_to_booking`.
 *
 * A rejection comes back as `isError: true` carrying the violations as JSON,
 * and not as a failed turn. `FAIL_REASONS` (src/engine.ts) does not grow a
 * `gate_rejected` entry and `turns_fail_reason_check` does not move, because a
 * rejected proposal is not a failure of the turn: it is a message the model can
 * act on with the step it has left, which is the whole reason the pipeline
 * returns every fault at once.
 */
export function proposalRunner(sql: postgres.Sql, ctx: ProposalContext, inner: ToolRunner): ToolRunner {
  return async (name, input, callId, signal) => {
    if (name !== 'propose_itinerary') return inner(name, input, callId, signal)

    // `refs` is read off the raw input with no validation at all, on purpose.
    // `runGates` applies `ProposalRefsSchema` itself and reports a structural
    // fault as a provenance violation with a gate_results row, so validating
    // here as well would mean one fault described twice, once as a tool error
    // and once as a gate verdict, with only one of them recorded.
    const refs = (input as { refs?: unknown } | null)?.refs
    const outcome = await runGates(sql, {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      turnId: ctx.turnId,
      refs,
      notebook: ctx.notebook,
      now: ctx.now(),
    })

    if (!outcome.ok) {
      return {
        content: JSON.stringify({ ok: false, violations: outcome.violations }),
        isError: true,
      }
    }
    // The row the cashier's precondition reads. Written from the refs the gates
    // VALIDATED, never from the raw input: the row is our record of what we
    // approved, not of what we were asked to approve. Written only on a pass,
    // because a rejected proposal is not something she can be asked to accept.
    const proposalId = await recordProposal(sql, {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      turnId: ctx.turnId,
      refs: outcome.items.map((i) => i.ref),
    })
    return {
      content: JSON.stringify({
        ok: true,
        proposalId,
        // The server's own total, in minor units and formatted, the same shape
        // every price on this wire takes (src/tools.ts's itemForModel), through
        // the same formatter.
        //
        // `formatted` is not decoration. The desk is told the total it sees is
        // never a number it wrote, and a bare `minor` takes that back: the
        // model would have to divide by an exponent to write the figure into
        // her reply. src/money.ts holds JPY at exponent 0 and KWD at 3, and
        // from this lesson the search currency follows her budget, so the
        // usual cents rule turns 46400 JPY into a reply saying 464.
        total: {
          minor: outcome.total.minor.toString(),
          currency: outcome.total.currency,
          formatted: formatMoney(outcome.total),
        },
        items: outcome.items.map((i) => ({ sourceId: i.item.sourceId, slot: i.ref.slot })),
      }),
      isError: false,
    }
  }
}
