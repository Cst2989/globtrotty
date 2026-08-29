import type { Money } from '../money.js'
import type { SupplierItem } from '../supplier/types.js'

/**
 * Every deterministic gate, in the order `runGates` runs them, as ONE runtime
 * constant — and `GateName` is derived from it rather than declared alongside it.
 *
 * The pipeline maps this array to build its `gate_results` rows, so a gate added
 * to the union is a gate that gets a row, by construction. A hand-kept parallel
 * list was the alternative, and its failure mode is the one this table exists to
 * prevent: a gate wired into the violation list but forgotten by the writer
 * produces NO row, and "no row" is indistinguishable from "the gate never ran".
 * A type union alone cannot carry that guarantee, because types are erased.
 *
 * ## What this does NOT guarantee — read before "simplifying" a test
 *
 * Deriving the list guarantees every gate gets a ROW. It does NOT guarantee the
 * row holds a real verdict: a name added here but never actually called files no
 * violation and is named in no `notEvaluated` reason, so it falls through to
 * `passed: true` — an unwired gate silently recording a pass on every proposal.
 * Nothing in the type system catches that.
 *
 * What catches it is the pair of assertions that pin the full seven-name row set
 * against literal expected values, in `test/gate-pipeline.test.ts`: 'writes a
 * gate_results row for every gate it ran, including the passes' (which asserts
 * `[true x 7]` by exact array equality) and 'writes a row for EVERY name in
 * GateName'. Those literals look redundant next to this constant and they are
 * not — replacing either with something derived from `GATE_NAMES` would make the
 * test assert only that the code agrees with itself. Leave them literal.
 *
 * 'reviewer' is deliberately NOT here. It needs a model and arrives in plan 3;
 * `gate_results.gate` already accepts the value, so the seam costs nothing, and
 * keeping it out of `GateName` is what stops the pipeline from writing a row
 * claiming a reviewer ran.
 */
export const GATE_NAMES = [
  'provenance', 'freshness', 'slots', 'currency', 'totals', 'budget', 'dates',
] as const

export type GateName = typeof GATE_NAMES[number]
export type ItemRef  = { sourceId: string; quantity: number; slot: string }
export type Violation = { gate: GateName; detail: string; sourceIds: string[] }
export type GateOutcome =
  | { ok: true;  items: RehydratedItem[]; total: Money }
  | { ok: false; violations: Violation[] }
export type RehydratedItem = { ref: ItemRef; item: SupplierItem; lineTotal: Money }
