import type postgres from 'postgres'
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
 * `corpusRunner` and inside `ledgerRunner`:
 *
 *   ledgerRunner(sql, claim,
 *     proposalRunner(sql, ctx,
 *       corpusRunner(sql, claim,
 *         supplierRunner(suppliers, ctx.notebook.currency))))
 *
 * Outside the corpus because a proposal is judged against what the corpus
 * already holds and writes nothing to it; inside the ledger because a replayed
 * proposal is correct, and running the gates twice against the same corpus at
 * the same instant produces the same verdict anyway. Every other tool name
 * falls through to `inner`, so each layer knows exactly one thing.
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
    return {
      content: JSON.stringify({
        ok: true,
        // The server's own total, in minor units and formatted, the same shape
        // every price on this wire takes (src/tools.ts's itemForModel).
        total: { minor: outcome.total.minor.toString(), currency: outcome.total.currency },
        items: outcome.items.map((i) => ({ sourceId: i.item.sourceId, slot: i.ref.slot })),
      }),
      isError: false,
    }
  }
}
