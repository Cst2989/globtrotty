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
