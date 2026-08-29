import type { Money } from '../money.js'
import type { SupplierItem } from '../supplier/types.js'

export type GateName =
  | 'provenance' | 'freshness' | 'currency' | 'slots' | 'totals' | 'budget' | 'dates'
export type ItemRef  = { sourceId: string; quantity: number; slot: string }
export type Violation = { gate: GateName; detail: string; sourceIds: string[] }
export type GateOutcome =
  | { ok: true;  items: RehydratedItem[]; total: Money }
  | { ok: false; violations: Violation[] }
export type RehydratedItem = { ref: ItemRef; item: SupplierItem; lineTotal: Money }
