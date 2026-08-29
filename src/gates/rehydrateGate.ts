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
    quantity: z.int().positive().max(16),
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
 *
 * `refs` is typed `ItemRef[]`, but TypeScript is erased at runtime — a caller
 * that skipped `ProposalRefsSchema` (or handed in raw, untyped model JSON cast
 * to the type) could still get an extra `price` key past the compiler. So the
 * schema is re-applied HERE, inside the function, rather than trusted to have
 * already run: the boundary check must not be skippable by construction. A
 * schema failure is reported as a `provenance` violation, not thrown — this
 * function's contract is "return a result the caller can record and hand back
 * to the model," the same contract every other failure path here already
 * uses, and a caller in the turn loop wants a violation to log and answer
 * with, not a `try/catch` around a `ZodError` for one specific failure mode
 * among several.
 */
export async function rehydrateRefs(
  sql: postgres.Sql,
  conversationId: string,
  refs: ItemRef[],
): Promise<RehydrateResult> {
  const parsed = ProposalRefsSchema.safeParse({ refs })
  if (!parsed.success) {
    const detail = `The proposal must reference search results and nothing else `
                 + `({sourceId, quantity, slot}). Rejected: `
                 + parsed.error.issues.map((i) => i.message).join('; ')
    return {
      ok: false,
      violations: [{ gate: 'provenance', sourceIds: [], detail }],
    }
  }
  const safeRefs = parsed.data.refs

  const found = await rehydrate(sql, conversationId, safeRefs.map((r) => r.sourceId))

  // Report ALL missing ids together. One-at-a-time rejection costs a model round
  // trip per bad reference, and the model cannot see the pattern in its own error.
  // Deduped: a direct (non-schema-mediated) call could in principle repeat an id.
  const missing = [...new Set(
    safeRefs.filter((r) => !found.has(r.sourceId)).map((r) => r.sourceId),
  )]
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
    items: safeRefs.map((ref) => {
      const item = found.get(ref.sourceId)!
      // Rebuild rather than alias the caller's ref object: every output field
      // is discarded-and-rebuilt from validated data, matching the class's
      // whole premise, not just `item`.
      return {
        ref: { sourceId: ref.sourceId, quantity: ref.quantity, slot: ref.slot },
        item,
        lineTotal: itemTotal(item, ref.quantity),
      }
    }),
  }
}
