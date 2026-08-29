import { z } from 'zod'
import { textOf, type ModelClient } from './client.js'
import { promptVersion } from './desks.js'
import { callAndRecord } from './metered.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
import { SEATS, withSeat } from './seats.js'

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
