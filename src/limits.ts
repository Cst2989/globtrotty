import type { Limits } from './engine.js'

/**
 * The one home for the SPEND ceilings and the two per-turn caps beside them.
 * Every tier that enforces one of these five numbers imports it from here rather
 * than redefining it: two consumers disagreeing about a money limit means one of
 * them is silently not enforcing what the other thinks it is.
 *
 * Five fields, and not every limit on the branch. Module 5 added several bounds
 * that each live beside the one thing they bound and have no second reader:
 * `ESCALATIONS_PER_DAY` (src/tools.ts), `SCOUT_MAX_CITIES` and
 * `SUPPLIER_CALL_COST` (src/tools/supplierBudget.ts), `MAX_BREAKPOINTS` and
 * `INTERMEDIATE_EVERY` (src/model/cache.ts), `DEFAULT_MEMORY_LIMIT` and
 * `MAX_SOURCE_FACTS_PER_KEY` (src/repo/memory.ts), `MAX_CARD_NAME_LEN`
 * (src/channel.ts), `MAX_STORED` and `TRUNCATE_ABOVE_BYTES`
 * (src/repo/model-calls.ts). What belongs here is a number two tiers could
 * disagree about, and what stays local is a number one function owns.
 */
export const DEFAULT_LIMITS: Limits = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50, across every user in one UTC day
  maxSteps: 12,                            // lesson 1.5's first guess, kept until a measurement replaces it
  maxSupplierCallsPerTurn: 6,              // two searches for flights, two for stays, two corrections
}
