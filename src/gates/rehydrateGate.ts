import { z } from 'zod'
import type postgres from 'postgres'
import { rehydrate } from '../repo/toolResults.js'
import { itemTotal } from '../supplier/types.js'
import { SLOT_KINDS } from './checks.js'
import type { ItemRef, RehydratedItem, Violation } from './types.js'

/**
 * The slot vocabulary as the model sees it, derived from `SLOT_KINDS` so the
 * set has exactly ONE definition. Before this, the schema accepted any string
 * up to 64 chars while `checkSlots` rejected everything outside `SLOT_KINDS`,
 * which meant the only way for a model to learn the vocabulary was to guess a
 * name, get a violation back, and read the list out of the error — a wasted
 * round trip per conversation, on a closed set we could simply have published.
 * A `z.enum` rejects the bad name at the boundary AND names the valid options
 * in the parse error, so the first reply already carries the answer.
 */
const SLOT_NAMES = Object.keys(SLOT_KINDS) as [
  keyof typeof SLOT_KINDS, ...(keyof typeof SLOT_KINDS)[],
]

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
    // Shape only. The VALUE is judged by `checkTotals`, which requires exactly
    // 1 because every shipped supplier prices the whole booking. Deliberately
    // not tightened to `z.literal(1)` here: a schema failure is reported as a
    // `provenance` violation with no source ids, and an inflated quantity is a
    // `totals` fault about specific items. Keeping the bound loose is what puts
    // the fault in the right `gate_results` row with the right ids on it.
    quantity: z.int().positive().max(16),
    slot: z.enum(SLOT_NAMES),
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
      //
      // `lineTotal` is computed from the REHYDRATED price and the ref's
      // quantity, and the quantity has not been judged yet — `checkTotals` owns
      // that verdict (see its `quantity must be 1` section) and files a `totals`
      // violation for anything above 1. So a `lineTotal` here can be inflated by
      // a model-chosen multiplier; it never escapes, because the same proposal
      // is rejected before any total is returned, and `checkTotals` recomputes
      // rather than trusting this value. Judging quantity here instead was
      // considered and rejected: this function's failures are `provenance`
      // faults, and a quantity fault is a `totals` fault — filing it under the
      // wrong gate name would put it in the wrong `gate_results` row.
      return {
        ref: { sourceId: ref.sourceId, quantity: ref.quantity, slot: ref.slot },
        item,
        lineTotal: itemTotal(item, ref.quantity),
      }
    }),
  }
}
