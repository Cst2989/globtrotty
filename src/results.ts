import { z } from 'zod'
import { maskIdChars, maskControlChars } from './sanitize.js'
import type { Cabin, Assumption } from './intake/brief.js'

/**
 * `results` and `choices` rows (plan 5): two more `messages.role` values
 * alongside `action` (src/actions.ts), written by our own code — never the
 * model, never the traveller — as a `messages` row whose `content` is this
 * module's JSON. `src/worker.ts`'s `loop()` hydrates each into a `system`
 * message via the two render functions below (see `src/engine.ts`'s
 * `LoopMessage` doc comment for why that role exists at all), and also
 * writes them as step "attachments" right after an agent `message`/`park`
 * row — see `AgentStep` in `src/worker.ts`.
 *
 * Same trust-boundary instinct as the operator channel: what reaches the
 * model is built entirely from this module's fixed template fragments plus
 * the payload's own ids/enums — a traveller cannot forge one by typing JSON
 * into the chat box because the `results`/`choices` roles are never written
 * from her message, and a supplier id is always run through `maskIdChars`
 * before it lands in a rendered note.
 */

// `Cabin` and `Assumption` are src/intake/brief.ts's (Task 3, landed
// concurrently) — re-exported here rather than duplicated, since every other
// interface in this module (`ResultsContent`, below) refers to them by these
// same names.
export type { Cabin, Assumption }

export type Filter = {
  nonstop?: boolean
  maxStops?: number
  departure?: 'morning' | 'afternoon' | 'evening'
  maxPriceMinor?: string
  airlines?: string[]
}

export type ResultsContent = {
  kind: 'flights' | 'hotels'
  query: {
    from?: string
    to?: string
    place?: string
    outbound: string
    inbound: string | null
    adults: number
    cabin?: Cabin
  }
  sourceIds: string[]
  assumptions: Assumption[]
  filter?: Filter
}

export type ChoicesContent = {
  questionId: string
  question: string
  options: { id: string; label: string }[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const CabinSchema = z.enum(['economy', 'premium_economy', 'business', 'first'])

const AssumptionSchema = z.strictObject({
  field: z.string().min(1).max(64),
  value: z.string().min(1).max(256),
  reason: z.enum(['unstated', 'defaulted', 'year']),
})

const FilterSchema = z.strictObject({
  nonstop: z.boolean().optional(),
  maxStops: z.number().int().min(0).max(10).optional(),
  departure: z.enum(['morning', 'afternoon', 'evening']).optional(),
  maxPriceMinor: z.string().regex(/^\d{1,12}$/).optional(),
  airlines: z.array(z.string().min(1).max(8)).optional(),
})

/**
 * `z.strictObject` at every level, same reason as `ActionPayload`
 * (src/actions.ts): this is the ONE place the result of a supplier search
 * becomes text the model reads, so an unexpected extra field is rejected at
 * the boundary rather than silently carried through. `sourceIds` are
 * supplier-origin and only ever reach the model through `renderResultsNote`,
 * which masks each one with `maskIdChars`.
 */
export const ResultsContentSchema = z.strictObject({
  kind: z.enum(['flights', 'hotels']),
  query: z.strictObject({
    from: z.string().min(1).max(64).optional(),
    to: z.string().min(1).max(64).optional(),
    place: z.string().min(1).max(128).optional(),
    outbound: z.string().regex(DATE_RE),
    inbound: z.string().regex(DATE_RE).nullable(),
    adults: z.number().int().min(1).max(20),
    cabin: CabinSchema.optional(),
  }),
  sourceIds: z.array(z.string().min(1).max(512)),
  assumptions: z.array(AssumptionSchema),
  filter: FilterSchema.optional(),
}) satisfies z.ZodType<ResultsContent>

/**
 * `questionId` matches the same shape as `ActionPayload`'s `choice` arm
 * (src/actions.ts) — ledger ruling 1: `IntakeOutcome.choices` carries
 * `questionId` ('origin' | 'destination' | 'outbound'), one of those short
 * lowercase names. `options[].id` matches `choice`'s `optionId` shape for
 * the same reason: it is exactly what comes back through that action once
 * she clicks. `question` and `label` are OUR OWN model's prose (the office
 * wrote them), not supplier- or traveller-authored, so they are plain bounded
 * strings rather than id-shaped — but `renderChoicesNote` below never embeds
 * a `label` into what the model reads, only `maskControlChars(question)` and
 * the option ids, so a label is never a channel for traveller-authored text
 * either way.
 */
export const ChoicesContentSchema = z.strictObject({
  questionId: z.string().regex(/^[a-z_]{1,32}$/),
  question: z.string().min(1).max(500),
  options: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
    label: z.string().min(1).max(200),
  })).min(1),
}) satisfies z.ZodType<ChoicesContent>

/**
 * Parses a `messages.content` string for a `results` row. Never throws: a
 * malformed row is `null`, and the caller hydrates that into
 * `UNREADABLE_ACTION_TEXT` rather than crashing the turn — the same contract
 * as `parseAction` (src/actions.ts).
 */
export function parseResults(content: string): ResultsContent | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = ResultsContentSchema.safeParse(json)
  return result.success ? result.data : null
}

/** Same contract as `parseResults`, for a `choices` row. */
export function parseChoices(content: string): ChoicesContent | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = ChoicesContentSchema.safeParse(json)
  return result.success ? result.data : null
}

/**
 * The text the model reads for a `results` row, via the same `system`-role
 * channel the operator actions use. Built entirely from this fixed template
 * plus the payload's own ids/enums/numbers; every `sourceId` is masked with
 * `maskIdChars` before it lands here, so a supplier-authored id can never put
 * a `"` or a newline into what the model reads.
 */
export function renderResultsNote(r: ResultsContent): string {
  const { kind, query, sourceIds } = r
  const n = sourceIds.length
  const from = query.from ?? query.place
  const to = query.to ?? ''
  const inboundPart = query.inbound ? ` returning ${query.inbound}` : ''
  const ids = sourceIds.map(maskIdChars).join(', ')
  return `Operator: the office showed her ${n} ${kind} for ${from} to ${to} on `
    + `${query.outbound}${inboundPart}; ids ${ids}. Discuss them; do not search again `
    + 'unless she changes the trip.'
}

/**
 * The text the model reads for a `choices` row. `question` is our own
 * model's prose, so it passes through `maskControlChars` (newline-injection
 * guard only, see src/sanitize.ts) rather than `maskUntrustedText`. Option
 * `label`s are never embedded — only their ids, which is all the model needs
 * to refer back to one of them.
 */
export function renderChoicesNote(c: ChoicesContent): string {
  const ids = c.options.map((o) => o.id).join(', ')
  return `Operator: the office asked her "${maskControlChars(c.question)}" with options `
    + `${ids}. Wait for her click.`
}
