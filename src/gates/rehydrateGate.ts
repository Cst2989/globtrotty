import { z } from 'zod'
import type postgres from 'postgres'
import { rehydrate } from '../repo/toolResults.js'
import { itemTotal } from '../supplier/types.js'
import type { ItemRef, RehydratedItem, Violation } from './types.js'

/**
 * The model may send references and NOTHING ELSE.
 *
 * This is the structural fix for the flaw the source articles' `checkProvenance`
 * carries: that version validates that a sourceId was SEEN and never checks the
 * values attached to it, so a model can cite a genuine hotel with a genuine id,
 * attach an invented €89/night, pass provenance, and have the budget check then
 * validate the invented number.
 *
 * There is no price field here to tamper with. `.strict()` makes an attempt to
 * supply one a hard parse failure rather than a silently ignored key — ignoring
 * it would work, but it would also hide the fact that the model tried, and that
 * attempt is a signal worth surfacing.
 *
 * Provenance defends against hallucination, not against an adversary who is
 * legitimately in the supplier's index.
 */
export const ProposalRefsSchema = z.strictObject({
  refs: z.array(z.strictObject({
    sourceId: z.string().min(1).max(512),
    quantity: z.int().positive(),
    slot: z.string().min(1).max(64),
  })).min(1).max(24)
    .refine(
      (refs) => new Set(refs.map((r) => r.sourceId)).size === refs.length,
      { message: 'duplicate sourceId in one proposal' },
    ),
})

export type RehydrateResult =
  | { ok: true; items: RehydratedItem[] }
  | { ok: false; violations: Violation[] }

/**
 * Reads every referenced item from the corpus and discards whatever the caller
 * thought those items were. Scoped to one conversation: an id seen in someone
 * else's conversation is not provenance for this one.
 */
export async function rehydrateRefs(
  sql: postgres.Sql,
  conversationId: string,
  refs: ItemRef[],
): Promise<RehydrateResult> {
  const found = await rehydrate(sql, conversationId, refs.map((r) => r.sourceId))

  // Report ALL missing ids together. One-at-a-time rejection costs a model round
  // trip per bad reference, and the model cannot see the pattern in its own error.
  const missing = refs.filter((r) => !found.has(r.sourceId)).map((r) => r.sourceId)
  if (missing.length > 0) {
    return {
      ok: false,
      violations: [{
        gate: 'provenance',
        sourceIds: missing,
        detail: `These items match no search result in this conversation: ${missing.join(', ')}. `
              + `Search for them first, then propose the ids the search returned.`,
      }],
    }
  }

  return {
    ok: true,
    items: refs.map((ref) => {
      const item = found.get(ref.sourceId)!
      return { ref, item, lineTotal: itemTotal(item, ref.quantity) }
    }),
  }
}
