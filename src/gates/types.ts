import type { Money } from '../money.js'
import type { SupplierItem, SupplierKind } from '../supplier/types.js'

/**
 * Every gate, in the order `runGates` runs them (lesson 4.5), as ONE runtime
 * constant, with `GateName` derived from it rather than declared beside it.
 *
 * The pipeline maps this array to build its `gate_results` rows, so a gate
 * added to the union is a gate that gets a row, by construction. The
 * alternative is a hand-kept parallel list, and its failure mode is the one
 * that table exists to prevent: a gate wired into the violation list and
 * forgotten by the writer produces NO row, and "no row" is indistinguishable
 * from "the gate never ran". A type union alone cannot carry that guarantee,
 * because types are erased.
 *
 * ## What this does NOT guarantee, read before simplifying a test
 *
 * Deriving the list guarantees every gate gets a ROW. It does not guarantee the
 * row holds a real verdict: a name added here but never actually called files
 * no violation and is named in no not-evaluated reason, so it falls through to
 * `passed: true`, which is an unwired gate silently recording a pass on every
 * proposal. Nothing in the type system catches that.
 *
 * What catches it is the pair of assertions lesson 4.5 writes into
 * test/gate-pipeline.test.ts, which pin the full seven-name row set against
 * LITERAL expected values. Those literals look redundant next to this constant
 * and they are not: replacing either with something derived from GATE_NAMES
 * would make the test assert only that the code agrees with itself. Leave them
 * literal.
 *
 * 'reviewer' is deliberately NOT here. It needs a model and it arrives in
 * module 5; lesson 4.5's migration 0012 writes a `gate_results.gate` that
 * accepts the value, so the seam costs nothing, and keeping it out of
 * `GateName` is what stops the pipeline writing a row claiming a reviewer ran.
 */
export const GATE_NAMES = [
  'provenance', 'freshness', 'slots', 'currency', 'totals', 'budget', 'dates',
] as const

export type GateName = typeof GATE_NAMES[number]

/**
 * The slot vocabulary, in ONE place: the set `ProposalRefsSchema` publishes to
 * the model as an enum (lesson 4.4) and the set `checkSlots` enforces (lesson
 * 4.5) cannot drift apart, because there is only one of them.
 *
 * The names come from what the codebase already models, not from invention.
 * `SupplierKind` is 'flight' or 'hotel', and `FlightDetail` carries an outbound
 * and an inbound leg. So:
 *
 *  - 'outbound' and 'inbound': a one-way item standing for a single leg, named
 *    after the two legs `FlightDetail` already names.
 *  - 'flight': one item covering the whole journey. Kiwi returns a return trip
 *    as a SINGLE SupplierItem whose detail holds both legs, so there has to be
 *    a slot for "the flights" as one line.
 *  - 'stay': the hotel.
 */
export const SLOT_KINDS = {
  outbound: 'flight',
  inbound:  'flight',
  flight:   'flight',
  stay:     'hotel',
} as const satisfies Record<string, SupplierKind>

/**
 * The whole of what a model may propose about one item. `slot` stays a plain
 * `string` rather than the union of `SLOT_KINDS`' keys: this type describes
 * what arrived, not what is valid, and `checkSlots` is exported and reachable
 * without the schema, so it has to be able to be handed a name nobody defined.
 */
export type ItemRef = { sourceId: string; quantity: number; slot: string }

/** One fault, named by the CLASS of fault rather than by the function that noticed it. */
export type Violation = { gate: GateName; detail: string; sourceIds: string[] }

/** A reference, resolved against the corpus, with the line total the server computed. */
export type RehydratedItem = { ref: ItemRef; item: SupplierItem; lineTotal: Money }

export type GateOutcome =
  | { ok: true;  items: RehydratedItem[]; total: Money }
  | { ok: false; violations: Violation[] }
