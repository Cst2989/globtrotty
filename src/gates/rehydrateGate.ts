import { z } from 'zod'
import type postgres from 'postgres'
import { rehydrate } from '../repo/toolResults.js'
import { itemTotal } from '../supplier/types.js'
import { SLOT_KINDS } from './types.js'
import type { ItemRef, RehydratedItem, Violation } from './types.js'

/**
 * The slot vocabulary as the model sees it, derived from `SLOT_KINDS` so the
 * set has exactly one definition. A `z.enum` rejects a bad name at the boundary
 * AND names the valid options in the parse error, so the first reply already
 * carries the answer; a bare `z.string()` here would mean the only way for a
 * model to learn a closed set we could simply have published is to guess a
 * name, get a violation back, and read the list out of the error.
 */
export const SLOT_NAMES = Object.keys(SLOT_KINDS) as [
  keyof typeof SLOT_KINDS, ...(keyof typeof SLOT_KINDS)[],
]

/**
 * The model may send references and NOTHING ELSE.
 *
 * This is the structural fix for the flaw the source articles' `checkProvenance`
 * carries, which lesson 1.4's own check shares. Lesson 1.4 shipped
 * `quotedAmounts` and `offeredAmounts` and nothing else; the id-seen half is the
 * articles' version, reproduced in `test/tampered-price.test.ts` rather than
 * imported, because no such function exists at any tag of this branch. Both
 * halves have the same hole and the demonstration runs both: the id check
 * validates that a sourceId was SEEN and never looks at the values attached to
 * it, and the amount check scans prose. So a model can cite a genuine hotel with
 * a genuine id, attach the price of the hotel beside it, pass provenance, and
 * have the budget check then validate the wrong number.
 *
 * There is no price field here to tamper with. `strictObject` makes an attempt
 * to supply one a hard parse failure rather than a silently ignored key:
 * ignoring it would work, and it would also hide the fact that the model tried,
 * and that attempt is a signal worth surfacing.
 *
 * Provenance defends against hallucination. It does not defend against an
 * adversary who is legitimately in the supplier's index.
 */
export const ProposalRefsSchema = z.strictObject({
  refs: z.array(z.strictObject({
    sourceId: z.string().min(1).max(512),
    // Shape only, and the shape has bounds. The VALUE is judged by
    // `checkTotals` (lesson 4.5), which requires exactly 1 because every
    // supplier this branch ships prices the whole booking. Deliberately not
    // tightened to `z.literal(1)` here: a schema failure is reported as a
    // `provenance` violation with no source ids, and a quantity of 2 is a
    // `totals` fault about specific items, so tightening it would file that
    // fault in the wrong `gate_results` row with no ids on it.
    //
    // A nonpositive or oversized quantity is the opposite case and is a
    // structural fault by design. Zero and minus one are not quantities of
    // anything and 17 is past any party this product books, so none of them is
    // a proposal an itemised reply could help with, and each lands here as a
    // provenance rejection rather than as a totals verdict. `ProposeInput`
    // (src/tools.ts) publishes these same two bounds, so a model reads them
    // instead of discovering them, and test/tools.test.ts pins that the
    // published document and this boundary still agree.
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
 * `refs` is typed `ItemRef[]`, and TypeScript is erased at runtime, so a caller
 * that skipped `ProposalRefsSchema`, or handed in raw untyped model JSON cast
 * to the type, could still get an extra `price` key past the compiler. The
 * schema is therefore re-applied HERE, inside the function, rather than trusted
 * to have already run: the boundary must not be skippable by construction.
 *
 * A schema failure is reported as a `provenance` violation, not thrown. This
 * function's contract is "return a result the caller can record and hand back
 * to the model", the same contract every other failure path here uses, and a
 * caller in the turn loop wants a violation to log and answer with rather than
 * a try/catch around a ZodError for one failure mode among several.
 */
export async function rehydrateRefs(
  sql: postgres.Sql,
  conversationId: string,
  refs: ItemRef[],
): Promise<RehydrateResult> {
  const parsed = ProposalRefsSchema.safeParse({ refs })
  if (!parsed.success) {
    const detail = 'The proposal must reference search results and nothing else '
                 + '({sourceId, quantity, slot}). Rejected: '
                 + parsed.error.issues.map((i) => i.message).join('; ')
    return { ok: false, violations: [{ gate: 'provenance', sourceIds: [], detail }] }
  }
  const safeRefs = parsed.data.refs

  const found = await rehydrate(sql, conversationId, safeRefs.map((r) => r.sourceId))

  // Report ALL missing ids together. One at a time costs a model round trip per
  // bad reference, and the model cannot see the pattern in its own error.
  // Not deduplicated, and it does not need to be: the schema's `.refine` above
  // rejects a proposal that repeats a sourceId, and it is re-applied on every
  // call, so `safeRefs` cannot hold one twice.
  const missing = safeRefs.filter((r) => !found.has(r.sourceId)).map((r) => r.sourceId)
  if (missing.length > 0) {
    return {
      ok: false,
      violations: [{
        gate: 'provenance',
        sourceIds: missing,
        detail: `These items match no search result in this conversation: ${missing.join(', ')}. `
              + 'Search for them first, then propose the ids the search returned.',
      }],
    }
  }

  return {
    ok: true,
    items: safeRefs.map((ref) => {
      const item = found.get(ref.sourceId)!
      // Rebuild rather than alias, so nothing the caller still holds is reachable
      // through the result: every output field is rebuilt from validated data,
      // which is the whole premise here and not only true of `item`. Against the
      // PARSED refs this is belt and braces, because zod hands back fresh objects
      // carrying exactly the declared keys; against the caller's own array it is
      // the difference between a returned ref and a live alias of model JSON.
      // `test/gate-rehydrate.test.ts`'s 'rebuilds the ref rather than handing
      // back the object it was given' is what holds it.
      //
      // `lineTotal` is computed from the REHYDRATED price and the ref's
      // quantity, and the quantity has not been judged yet: `checkTotals` owns
      // that verdict (lesson 4.5) and files a `totals` violation for anything
      // above 1. So a lineTotal here can be inflated by a model-chosen
      // multiplier, and it never escapes, because the same proposal is rejected
      // before any total is returned and `checkTotals` recomputes rather than
      // trusting this value. Judging quantity here instead was considered and
      // rejected: this function's failures are `provenance` faults, and a
      // quantity fault is a `totals` fault, so filing it here would put it in
      // the wrong gate_results row.
      return {
        ref: { sourceId: ref.sourceId, quantity: ref.quantity, slot: ref.slot },
        item,
        lineTotal: itemTotal(item, ref.quantity),
      }
    }),
  }
}
