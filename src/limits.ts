import type { Limits } from './engine.js'

/**
 * The one home for the production ceilings. Every tier that enforces a limit
 * imports this rather than redefining the numbers: two consumers disagreeing
 * about a money limit means one of them is silently not enforcing what the other
 * thinks it is.
 */
export const DEFAULT_LIMITS: Limits = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50, across every user in one UTC day
  maxSteps: 12,                            // lesson 1.5's first guess, kept until a measurement replaces it
  maxSupplierCallsPerTurn: 6,              // two searches for flights, two for stays, two corrections
}
