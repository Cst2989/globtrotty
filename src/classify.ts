/**
 * The label that decides which desk answers her, and the two functions that ask
 * for it. `classify` is lesson 1.2's, still called from `turn()`
 * (src/conversation.ts) and still replayed by the recorded fixtures modules 1
 * and 2 built, so it keeps its behaviour exactly. `classifyDesk` is the
 * driver's, added at lesson 5.3, and it is the one that tells a parse failure
 * apart from the label `other`. There are two because the first is a contract
 * with four recorded fixtures and the second is a rule about what happens when
 * the schema comes back unreadable, and rewriting the first to carry the second
 * would have changed what those fixtures prove.
 */
import { z } from 'zod'
import { textOf, type ModelClient } from './client.js'
import { promptVersion } from './desks.js'
import { callAndRecord } from './metered.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
import { SEATS, withSeat } from './seats.js'
import type { Desk } from './tools/registry.js'

export const LABELS = ['new_trip', 'change', 'faq', 'other'] as const
export type Label = (typeof LABELS)[number]

const LabelSchema = z.object({ label: z.enum(LABELS) })

const SYSTEM =
  'You label one message from a traveller writing to a travel agency. ' +
  'new_trip: she wants a trip planned. change: she wants an existing plan or booking changed. ' +
  'faq: a short factual question with no planning in it. other: anything else. ' +
  'Answer with the label only.'

export type Classified = { label: Label; usage: Usage; costMicros: bigint }

/**
 * A one-word answer we can check against her message, so it runs on the
 * cheap seat. A reply that fails to parse becomes "other", which the router
 * sends to the seat that can handle anything.
 */
export async function classify(text: string, client: ModelClient, record?: ModelCallSink): Promise<Classified> {
  const message = await callAndRecord(
    client,
    withSeat(SEATS.cheap, {
      max_tokens: 64,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: z.toJSONSchema(LabelSchema) } },
    }),
    { seat: SEATS.cheap, promptVersion: promptVersion(SYSTEM), record },
  )
  const usage = usageOf(message)
  let label: Label = 'other'
  try {
    const parsed = LabelSchema.safeParse(JSON.parse(textOf(message)))
    if (parsed.success) label = parsed.data.label
  } catch {
    label = 'other'
  }
  return { label, usage, costMicros: costMicros(SEATS.cheap.model, usage) }
}

/**
 * Which desk answers her, and the label that decided it.
 *
 * `label` is null when the reply did not parse. That is a different fact from
 * `'other'`, which is a label the model can legitimately return, and keeping the
 * two apart is the whole of this change: until this lesson a parse failure
 * became `'other'` and the two were the same word in the same field, so nobody
 * could ask how often the structured output failed.
 *
 * `promptVersion` is returned rather than recomputed by the caller. `SYSTEM` is
 * a const in this file and nothing outside it can hash the bytes that were
 * actually sent, so a caller writing its own row would have to hand-write a
 * literal, and a hand-written prompt version is one that stops changing the day
 * somebody edits the prompt in a hurry. Every other prompt on this branch
 * carries a twelve-hex SHA-256 of its own text and `test/desks.test.ts` asserts
 * that property; this keeps the classifier inside it.
 */
export type Routing = {
  desk: Desk
  label: Label | null
  promptVersion: string
  usage: Usage
  costMicros: bigint
  /**
   * How long the call took, measured here because the caller writes the row.
   * `callAndRecord` measures its own (src/metered.ts) and does not return the
   * figure, and `selectDesk` (src/agents/driver.ts) is handed no sink, so a
   * caller with nothing to return would have to write a literal. Every other row
   * in course.model_calls carries a real measurement, and one seat reporting
   * exactly zero is the fastest seat in the product by a percentile query an
   * operator would act on.
   */
  latencyMs: number
}

const VERSION = promptVersion(SYSTEM)

/**
 * One cheap call that decides which desk she reaches.
 *
 * Structured output, with the label set published as a JSON schema, because the
 * alternative is reading a word out of prose and hoping. On ANY parse failure
 * this routes to planning: never a guess, never a drop, and never `'other'`
 * standing in for "we could not read the answer" (SPEC section 3).
 *
 * Planning is the safe side rather than the cheap one, and that is deliberate.
 * The front desk holds no tools at all (`DESK_TOOLS.front`), so a trip request
 * misrouted to it cannot be planned and she is told to rephrase something she
 * phrased correctly. A factual question misrouted to planning is answered
 * correctly and costs five times as much. One of those two failures is
 * recoverable by the model within the same turn, and it is the expensive one.
 *
 * The failure is logged, because a rate that climbs is the only signal that a
 * model update changed how it answers a schema, and a silent fallback would
 * present that as a shift in what travellers are asking about.
 */
export async function classifyDesk(
  text: string, client: ModelClient, record?: ModelCallSink,
): Promise<Routing> {
  const startedMs = Date.now()
  const message = await callAndRecord(
    client,
    withSeat(SEATS.front_desk, {
      max_tokens: SEATS.front_desk.maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: z.toJSONSchema(LabelSchema) } },
    }),
    // `callAndRecord`'s meta is `{ seat, promptVersion, record?, signal? }` and
    // carries no seatConfig: it derives the row's seat settings from `seat`
    // itself (src/metered.ts, lesson 5.1 step 10). Passing one here would not
    // compile, and would be a second copy of a value that is already there.
    { seat: SEATS.front_desk, promptVersion: VERSION, record },
  )
  const latencyMs = Date.now() - startedMs
  const usage = usageOf(message)
  const cost = costMicros(SEATS.front_desk.model, usage)

  let label: Label | null = null
  try {
    const parsed = LabelSchema.safeParse(JSON.parse(textOf(message)))
    if (parsed.success) label = parsed.data.label
  } catch {
    label = null
  }
  if (label === null) {
    console.error('classifyDesk: structured label did not parse, routing to planning')
    return { desk: 'planning', label: null, promptVersion: VERSION, usage, costMicros: cost, latencyMs }
  }
  return {
    desk: label === 'faq' ? 'front' : 'planning',
    label, promptVersion: VERSION, usage, costMicros: cost, latencyMs,
  }
}
