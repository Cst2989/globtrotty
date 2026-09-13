import { z } from 'zod'
import { ProposalRefsSchema, SLOT_NAMES } from '../gates/rehydrateGate.js'

export type Desk = 'front' | 'planning'

/**
 * Where a tool's result comes from, which is what decides whether it is fenced.
 *
 * `code` is ours: our gates, our notebook, our cashier. `api` is a third party
 * we paid to answer. `worker` is a model of our own reading something untrusted,
 * which arrives at lesson 5.4 and is fenced for the same reason `api` is: a
 * paraphrase of an untrusted page is still untrusted.
 *
 * The article this course is built from calls this field `behind`, as in "what
 * stands behind this door". It is `door` here for one reason: `fenceResult(name,
 * door, raw, nonce)` reads correctly and `behind: 'code'` reads as a preposition with
 * nothing after it.
 */
export type ToolDoor = 'code' | 'worker' | 'api'

export type ToolDef = {
  readonly name: string
  readonly door: ToolDoor
  readonly schema: z.ZodType
  readonly description: string
}

/**
 * A date on the wire is ISO yyyy-mm-dd, and the schema enforces it rather than
 * only describing it, because the alternative is a mislabelled failure. A hotel
 * date the model sends reaches `nightsBetween` (src/supplier/dates.ts), which
 * throws a RangeError on anything else; that throw surfaces from inside
 * `supplier.search`, where `supplierRunner` has no way left to tell it apart
 * from a supplier that fell over, and would report the model's own typo as an
 * outage. A flight date never reaches it and fails worse: the mock hashes the
 * string it was given and hands the model an itinerary whose `departureLocal`
 * is built out of the typo. A model told the supplier failed re-issues the
 * identical call. A model told its input was invalid fixes the date.
 *
 * This is a format check and not a calendar check: `2026-02-31` passes here and
 * `nightsBetween` will happily count to it. Rejecting an impossible date is
 * lesson 4.5's dates gate, which has her trip in front of it and can say what
 * is wrong with it.
 */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('yyyy-mm-dd')

// Exported, unlike main's, because src/tools.ts keeps `FlightToolInput` and
// `HotelToolInput` as `z.infer` of these two so `flightSearchFrom` and
// `hotelSearchFrom` keep their parameter types, and a `z.infer` of a
// module-private const cannot be written. One schema, two readers.
export const FlightInput = z.strictObject({
  from: z.string().length(3).describe('IATA code of the departure airport'),
  to: z.string().length(3).describe('IATA code of the arrival airport'),
  departureDate: IsoDate,
  returnDate: IsoDate.nullable().describe('yyyy-mm-dd, or null for one way'),
  adults: z.int().min(1).max(9),
  children: z.int().min(0).max(9),
})

export const HotelInput = z.strictObject({
  city: z.string().min(1).max(120),
  checkIn: IsoDate,
  checkOut: IsoDate,
  adults: z.int().min(1).max(9),
  children: z.int().min(0).max(9),
})

const AskUser = z.strictObject({
  questions: z.array(z.string().min(1).max(300)).min(1).max(3),
})

const HandOffInput = z.strictObject({
  proposalId: z.string().describe('The id propose_itinerary returned for the proposal she accepted'),
})

/**
 * Provenance is assigned by the HARNESS, never by the model: this schema accepts
 * no `source` and no `stated_by`, and `strictObject` is what makes that true
 * rather than merely intended, because a plain `object` would ignore an extra
 * key instead of rejecting it. `applyRequirementsPatch` (src/repo/notebook.ts)
 * takes the provenance from its caller, and `provenanceFor`
 * (src/agents/driver.ts) derives it from the transcript.
 *
 * `patch` itself is deliberately a free record HERE and checked elsewhere. What
 * this file publishes is the JSON schema the model reads, and a per-field schema
 * in the model's copy is advice rather than a check; the check is `PatchSchema`
 * in src/notebook.ts, which every writer of the notebook goes through. So the
 * `strictObject` claim above is exactly true of the one key this object
 * declares, `patch`, and the keys INSIDE `patch` are made true one layer down.
 */
const UpdateRequirements = z.strictObject({
  patch: z.record(z.string(), z.unknown())
    .describe('The fields she has stated, by name. Never invent a value she did not state.'),
})

/**
 * One line of a card she is looking at, changed. `slot` is `SLOT_NAMES`, the
 * same vocabulary `ProposalRefsSchema` publishes and `checkSlots` enforces, so
 * a revision cannot name a component a proposal could never have had.
 *
 * `instruction` is her words and is bounded at 300 characters, like `ask_user`'s
 * questions: it goes back into the model's own context, and a tool input with no
 * ceiling is an input a long supplier payload can be copied into.
 */
const ReviseComponent = z.strictObject({
  proposalId: z.string().describe('The proposal she is looking at'),
  slot: z.enum(SLOT_NAMES).describe('Which component of it she wants changed'),
  instruction: z.string().min(1).max(300)
    .describe('What she asked for, in her words. Never a price and never a source id.'),
})

/**
 * Fixed format, and every field is an id or a member of an enum. There is no
 * free text here and that is the design: an escalation is read by a person who
 * is deciding whether to act, and a model-written summary of why a person is
 * needed is a model persuading a person. The turn's own transcript is what they
 * read; this row is what routes it.
 *
 * Rate limited per user per day, in the handler, because an escalation is a
 * person's time and a model in a loop can spend a great deal of it.
 */
const EscalateToHuman = z.strictObject({
  reason: z.enum(['outside_scope', 'supplier_dispute', 'safety', 'she_asked'])
    .describe('Why a person is needed. One of exactly these four.'),
  proposalId: z.string().nullable().describe('The proposal this is about, or null'),
})

const ResearchDestination = z.strictObject({
  cities: z.array(z.string().min(1).max(60)).min(1).max(3)
    .describe('Up to three cities to look at in parallel'),
  question: z.string().min(1).max(300)
    .describe('One question, asked of every city, answered in prose and never with a price'),
})

/**
 * Every tool the product owns, keyed by name, with what stands behind each.
 *
 * A record rather than the SDK's `Tool[]`, which is what `src/tools.ts` shipped
 * until this lesson, because the two consumers want two different things: the
 * validator wants to look a name up in constant time and read its door and its
 * zod schema, and the API wants a published JSON schema. `toolsForDesk` derives
 * the second from the first, so there is one declaration and not two.
 */
export const TOOLS: Record<string, ToolDef> = {
  update_requirements: {
    name: 'update_requirements', door: 'code', schema: UpdateRequirements,
    description: 'Record what she has told you into the notebook. Never invent a value she did '
      + 'not state. The notebook comes back rendered, and a refused key is named.',
  },
  ask_user: {
    name: 'ask_user', door: 'code', schema: AskUser,
    description: 'Ask her one to three questions and stop. Use when a missing fact blocks planning.',
  },
  search_flights: {
    name: 'search_flights', door: 'api', schema: FlightInput,
    description: 'Search return flights between two airports. Returns offers with a price the '
      + 'supplier quoted, its age and how long it stays quotable. Quote those prices exactly, '
      + 'never a total you worked out yourself.',
  },
  search_hotels: {
    name: 'search_hotels', door: 'api', schema: HotelInput,
    description: 'Search hotels in a city for a stay. Returns offers priced for the whole stay, '
      + 'with the price\'s age. Quote those prices exactly, never a total you worked out yourself.',
  },
  propose_itinerary: {
    name: 'propose_itinerary', door: 'code', schema: ProposalRefsSchema,
    description: 'Propose a set of search results as her trip. Send references only: {sourceId, '
      + 'quantity, slot}. Never send a price, a total or a name; the server reads all of those '
      + 'from its own record of the search and will reject a proposal that carries any of them. '
      + 'The quantity is always 1 and one sourceId may appear only once in a proposal.',
  },
  research_destination: {
    name: 'research_destination', door: 'worker', schema: ResearchDestination,
    description: 'Send a scout to up to three cities at once with one question. Each comes back '
      + 'with a short brief in prose, never a price and never a source id. Use this before '
      + 'searching, to decide which city to search.',
  },
  hand_off_to_booking: {
    name: 'hand_off_to_booking', door: 'code', schema: HandOffInput,
    description: 'Hand her over to the supplier to book a proposal she has accepted. Send the '
      + 'proposal id and nothing else: the server re-checks every price, builds every link '
      + 'itself, and refuses if anything moved or could not be confirmed.',
  },
  revise_component: {
    name: 'revise_component', door: 'code', schema: ReviseComponent,
    description: 'She asked to change one part of a proposal she is looking at. Search again for '
      + 'that slot only, keep every other component as it is, and propose the whole trip again.',
  },
  escalate_to_human: {
    name: 'escalate_to_human', door: 'code', schema: EscalateToHuman,
    description: 'Hand this request to a person at the agency. Use it when the request is outside '
      + 'what you can do, when she asks for a person, or when a supplier dispute or a safety '
      + 'matter needs one. Say so plainly to her afterwards and propose nothing further.',
  },
}

/**
 * The doors out of each desk. The front desk has none, so an FAQ can never start
 * a search, which is the whole reason a factual question is answered on the
 * cheap seat for a tenth of the price.
 */
export const DESK_TOOLS: Record<Desk, readonly string[]> = {
  front: [],
  planning: ['update_requirements', 'ask_user', 'research_destination', 'search_flights',
             'search_hotels', 'propose_itinerary', 'hand_off_to_booking',
             'revise_component', 'escalate_to_human'],
}

/**
 * The published shape, derived on demand rather than declared a second time.
 *
 * `z.toJSONSchema` emits a `$schema` key into every result. It is ignored by the
 * API and left in place rather than stripped, because removing it would mean
 * editing generated output and a future zod release changing that key is
 * something we would rather see than have silently deleted.
 *
 * `.refine()` predicates are silently DROPPED by `z.toJSONSchema`, so
 * `ProposalRefsSchema`'s duplicate-sourceId check does not reach the model at
 * all. It still runs inside `safeParse`, so `validateToolCall` enforces it; the
 * model learns about it by being told in the description rather than by the
 * schema. That is also why `src/tools.ts`'s old `ProposeInput`, a second
 * declaration written purely so the refinement could be dropped, is deleted by
 * this lesson: there is one schema now, and the reason the second one existed is
 * this paragraph.
 */
export function toolsForDesk(desk: Desk): unknown[] {
  return DESK_TOOLS[desk].map((n) => {
    const t = TOOLS[n]!
    return { name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema) }
  })
}
