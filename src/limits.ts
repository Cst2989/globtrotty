import type { Limits } from './engine.js'

/**
 * The one shared home for production spend/step ceilings. Every tier that enforces a limit
 * (the background function today; the Next.js route that calls `submitMessage` once it
 * exists) must import this rather than redefine the numbers — two consumers disagreeing on a
 * money limit means one of them silently isn't enforcing what the other thinks it is. Same
 * shape as Task 10's shared sweeper-staleness constant: a value with more than one consumer
 * gets exactly one definition.
 */
export const DEFAULT_LIMITS: Limits = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50, across ALL users in one UTC day
  maxSteps: 24,
  maxSupplierCallsPerTurn: 12,             // enough for a realistic date/airport sweep, far below a runaway
}
