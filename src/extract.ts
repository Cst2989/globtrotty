import { z } from 'zod'
import { textOf, type ModelClient } from './client.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import { SEATS, withSeat } from './seats.js'

// The API's output_config.format rejects numeric bound keywords outright:
// exclusiveMinimum ("For 'number' type..."), then minimum on a plain number,
// then minimum/maximum on an integer ("For 'integer' type, properties
// maximum, minimum are not supported" -- z.number().int() emits JS's safe-
// integer range as minimum/maximum, so even a bare .int() trips this). Every
// numeric range constraint (.positive(), .min(), .max(), .int()) below is
// dropped for that reason; the resulting Requirements type is unchanged
// (fields stay `number`), and checkAgainstMessage is the real guard against
// a value the message never stated.
export const RequirementsSchema = z.object({
  budget: z.object({ amount: z.number(), currency: z.string().length(3) }).nullable(),
  destination: z.string().min(1).nullable(),
  originCity: z.string().min(1).nullable(),
  nights: z.number().nullable(),
  month: z.string().min(1).nullable(),
  partySize: z.object({ adults: z.number(), children: z.number(), infants: z.number() }).nullable(),
  nearBeach: z.boolean().nullable(),
  needsCrib: z.boolean().nullable(),
})
export type Requirements = z.infer<typeof RequirementsSchema>

export const EMPTY_REQUIREMENTS: Requirements = {
  budget: null, destination: null, originCity: null, nights: null, month: null,
  partySize: null, nearBeach: null, needsCrib: null,
}

const SYSTEM =
  'Extract trip requirements from one message. Fill a field only when the message states it; ' +
  'leave every other field null. Never guess a number. Currency is the ISO code, EUR for euros.'

/** Digits as she typed them, with thousands separators removed: "1,500" and "1.500" both become "1500". */
function digitsIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(/\d[\d.,]*\d|\d/g)) {
    found.add(match[0].replace(/[.,]/g, ''))
  }
  return found
}

function wordsIn(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}]+/gu) ?? [])
}

/**
 * A number that does not appear in her message never reaches our pricing
 * code, whatever the model believed. Strings must share at least one word
 * with the message. Booleans and party sizes are judgments about her words,
 * so they pass through and the desk confirms them with her.
 */
export function checkAgainstMessage(requirements: Requirements, text: string): { kept: Requirements; dropped: (keyof Requirements)[] } {
  const digits = digitsIn(text)
  const words = wordsIn(text)
  const kept: Requirements = { ...requirements }
  const dropped: (keyof Requirements)[] = []
  if (kept.budget && !digits.has(String(kept.budget.amount))) { kept.budget = null; dropped.push('budget') }
  if (kept.nights !== null && !digits.has(String(kept.nights)) && !mentionsAWeek(kept.nights, words)) { kept.nights = null; dropped.push('nights') }
  for (const field of ['destination', 'originCity', 'month'] as const) {
    const value = kept[field]
    if (value && !value.toLowerCase().split(/\s+/).some((word) => words.has(word))) { kept[field] = null; dropped.push(field) }
  }
  return { kept, dropped }
}

function mentionsAWeek(nights: number, words: Set<string>): boolean {
  return nights === 7 && (words.has('week') || words.has('seven'))
}

export type Extracted = { requirements: Requirements; dropped: (keyof Requirements)[]; usage: Usage; costMicros: bigint }

export async function extract(text: string, client: ModelClient): Promise<Extracted> {
  const message = await client.create(
    withSeat(SEATS.cheap, {
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: z.toJSONSchema(RequirementsSchema) } },
    }),
  )
  const usage = usageOf(message)
  const cost = costMicros(SEATS.cheap.model, usage)
  let parsed: Requirements = EMPTY_REQUIREMENTS
  try {
    const result = RequirementsSchema.safeParse(JSON.parse(textOf(message)))
    if (result.success) parsed = result.data
  } catch {
    parsed = EMPTY_REQUIREMENTS
  }
  const { kept, dropped } = checkAgainstMessage(parsed, text)
  return { requirements: kept, dropped, usage, costMicros: cost }
}
