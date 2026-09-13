import { z } from 'zod'
import { textOf, type ModelClient } from './client.js'
import { promptVersion } from './desks.js'
import { callAndRecord } from './metered.js'
import { money, minorUnitExponent, type Money } from './money.js'
import { costMicros, usageOf, type Usage } from './pricing.js'
import type { ModelCallSink } from './repo/model-calls.js'
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
/** What the model is asked for: whole units, the way she typed them. */
export type RawRequirements = z.infer<typeof RequirementsSchema>

/** What the rest of the system uses. One conversion, at the boundary. */
export type Requirements = Omit<RawRequirements, 'budget'> & { budget: Money | null }

export const EMPTY_RAW: RawRequirements = {
  budget: null, destination: null, originCity: null, nights: null, month: null,
  partySize: null, nearBeach: null, needsCrib: null,
}
export const EMPTY_REQUIREMENTS: Requirements = { ...EMPTY_RAW, budget: null }

/**
 * 1,500 euros becomes 150000 minor units. Rounded, not truncated, because a
 * model that answers 1499.999 must not become 1,499.99.
 */
export function toRequirements(raw: RawRequirements): Requirements {
  if (raw.budget === null) return { ...raw, budget: null }
  const exponent = minorUnitExponent(raw.budget.currency)
  return { ...raw, budget: money(Math.round(raw.budget.amount * 10 ** exponent), raw.budget.currency) }
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
export function checkAgainstMessage(requirements: RawRequirements, text: string): { kept: RawRequirements; dropped: (keyof RawRequirements)[] } {
  const digits = digitsIn(text)
  const words = wordsIn(text)
  const kept: RawRequirements = { ...requirements }
  const dropped: (keyof RawRequirements)[] = []
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

export type Extracted = { requirements: Requirements; dropped: (keyof RawRequirements)[]; usage: Usage; costMicros: bigint }

export async function extract(text: string, client: ModelClient, record?: ModelCallSink): Promise<Extracted> {
  const message = await callAndRecord(
    client,
    withSeat(SEATS.cheap, {
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
      output_config: { format: { type: 'json_schema', schema: z.toJSONSchema(RequirementsSchema) } },
    }),
    { seat: SEATS.cheap, promptVersion: promptVersion(SYSTEM), record },
  )
  const usage = usageOf(message)
  // `'5m'`, for the reason `classify` gives: this request is assembled by
  // `withSeat` and carries no `cache_control`, so it writes no cache.
  const cost = costMicros(SEATS.cheap.model, usage, '5m')
  let parsed: RawRequirements = EMPTY_RAW
  try {
    const result = RequirementsSchema.safeParse(JSON.parse(textOf(message)))
    if (result.success) parsed = result.data
  } catch {
    parsed = EMPTY_RAW
  }
  const { kept, dropped } = checkAgainstMessage(parsed, text)
  return { requirements: toRequirements(kept), dropped, usage, costMicros: cost }
}
