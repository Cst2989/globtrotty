import { z } from 'zod'
import { ProposalRefsSchema } from '../gates/rehydrateGate.js'

export type Desk = 'front' | 'planning'
/** Where a tool's result comes from, which decides whether it must be fenced. */
export type ToolDoor = 'code' | 'worker' | 'api'

export type ToolDef = {
  readonly name: string
  readonly door: ToolDoor
  readonly schema: z.ZodType
  readonly description: string
}

const AskUser = z.strictObject({
  questions: z.array(z.string().min(1).max(300)).min(1).max(3),
})

const FlightSearch = z.strictObject({
  from: z.string().length(3), to: z.string().length(3),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  adults: z.int().positive().max(9),
})

const HotelSearch = z.strictObject({
  query: z.string().min(1).max(120),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.int().positive().max(9),
})

/**
 * Provenance is assigned by the HARNESS, never by the model: this schema accepts
 * no `source`/`stated_by` field, and there is nothing here for the model to set.
 * `applyRequirements(current, patch, source)` (src/notebook.ts) takes the
 * provenance from its CALLER — it stamps nothing on its own — so Task 10 decides
 * it, and spec section 4's "only user-message-derived changes may relax a
 * constraint" is enforced there.
 */
const UpdateRequirements = z.strictObject({
  patch: z.record(z.string(), z.unknown()),
})

export const TOOLS: Record<string, ToolDef> = {
  update_requirements: { name: 'update_requirements', door: 'code', schema: UpdateRequirements,
    description: 'Record what she has told you into the notebook. Never invent a value she did not state.' },
  ask_user: { name: 'ask_user', door: 'code', schema: AskUser,
    description: 'Ask her 1-3 questions and stop. Use when a missing fact blocks planning.' },
  explore_flights: { name: 'explore_flights', door: 'api', schema: FlightSearch,
    description: 'Search flights. ISO dates only. Returns references you may propose by id.' },
  explore_hotels: { name: 'explore_hotels', door: 'api', schema: HotelSearch,
    description: 'Search stays. ISO dates only. Returns references you may propose by id.' },
  propose_itinerary: { name: 'propose_itinerary', door: 'code', schema: ProposalRefsSchema,
    description: 'Propose an itinerary as REFERENCES to search results: {sourceId, quantity, slot}. Never send prices — they are rehydrated server-side and yours are discarded.' },
}

/**
 * Spec section 3. The front desk holds no tools: one call, one structured label.
 * Only tools with a handler in THIS plan are listed — advertising a tool with no
 * handler guarantees the model calls it and gets an error.
 */
export const DESK_TOOLS: Record<Desk, readonly string[]> = {
  front: [],
  planning: ['update_requirements', 'ask_user', 'explore_flights', 'explore_hotels',
             'propose_itinerary'],
}

/**
 * `z.toJSONSchema` emits a `$schema` key into every result. It is ignored by the
 * API and left in place rather than stripped: removing it would mean editing
 * generated output, and the next zod release changing that key is a thing we
 * would rather see than have silently deleted.
 *
 * Note also that `.refine()` predicates are silently DROPPED from the JSON
 * Schema — `ProposalRefsSchema`'s duplicate-sourceId check does not reach the
 * model. It still runs in `safeParse`, so `validateToolCall` enforces it; the
 * model simply learns about it by being told, rather than by construction.
 */
export function toolsForDesk(desk: Desk): unknown[] {
  return DESK_TOOLS[desk].map((n) => {
    const t = TOOLS[n]!
    return { name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema) }
  })
}
