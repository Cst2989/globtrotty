import { z } from 'zod'
import { money, type Money, compareMoney } from './money.js'

export type Provenance = 'user' | 'inferred' | 'tool'

export type Field<T> = { value: T; source: Provenance; at: string } | null

export type Notebook = {
  budget: Field<Money>
  destination: Field<string>
  originCity: Field<string>
  departureDate: Field<string>      // ISO 8601
  returnDate: Field<string>
  nights: Field<number>
  partySize: Field<{ adults: number; children: number; infants: number }>
  nearBeach: Field<boolean>
  needsCrib: Field<boolean>
  maxStops: Field<number>
  notes: Field<string>
}

// Fields where a looser value costs the traveller money or safety.
// Only a `user` source may relax these.
export const CONSTRAINT_FIELDS = ['budget', 'maxStops', 'nights'] as const

const MoneyIn = z.object({ minor: z.union([z.string(), z.number()]), currency: z.string() })

const PatchSchema = z.object({
  budget: MoneyIn.optional(),
  destination: z.string().min(1).optional(),
  originCity: z.string().min(1).optional(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nights: z.number().int().min(1).max(60).optional(),
  partySize: z.object({
    adults: z.number().int().min(1).max(9),
    children: z.number().int().min(0).max(9).default(0),
    infants: z.number().int().min(0).max(9).default(0),
  }).optional(),
  nearBeach: z.boolean().optional(),
  needsCrib: z.boolean().optional(),
  maxStops: z.number().int().min(0).max(3).optional(),
  notes: z.string().max(2000).optional(),
}).strict()

export const NotebookSchema = PatchSchema

export function emptyNotebook(): Notebook {
  return {
    budget: null, destination: null, originCity: null, departureDate: null,
    returnDate: null, nights: null, partySize: null, nearBeach: null,
    needsCrib: null, maxStops: null, notes: null,
  }
}

/** Returns a looser-than check: true when `next` gives the traveller less protection. */
function relaxes(key: string, current: unknown, next: unknown): boolean {
  if (current == null) return false
  if (key === 'budget') {
    return compareMoney((next as Money), (current as Money)) > 0
  }
  if (key === 'maxStops' || key === 'nights') {
    return (next as number) > (current as number)
  }
  return false
}

export function applyRequirements(
  current: Notebook,
  patch: unknown,
  source: Provenance,
): { next: Notebook; rejected: string[] } {
  const parsed = PatchSchema.safeParse(patch)
  if (!parsed.success) {
    // A patch that fails validation — whether from an unrecognised key or a
    // malformed known field — is rejected wholesale, not applied field by
    // field. Partially applying an attacker-influenced patch is a worse
    // failure than discarding it; `rejected` still names every offending
    // key so the caller can see why nothing landed.
    // zod reports extraneous keys via `issue.keys` (path is empty for
    // `unrecognized_keys`), and per-field validation failures via `issue.path`.
    const rejected: string[] = []
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const k of issue.keys) rejected.push(k)
      } else {
        rejected.push(String(issue.path[0] ?? 'unknown'))
      }
    }
    return { next: current, rejected: [...new Set(rejected)] }
  }

  const data = parsed.data as Record<string, unknown>
  const rejected: string[] = []
  const next: Notebook = { ...current }
  const at = new Date().toISOString()

  for (const [key, raw] of Object.entries(data)) {
    if (raw === undefined) continue

    let value: unknown = raw
    if (key === 'budget') {
      const m = raw as z.infer<typeof MoneyIn>
      let parsedMoney: Money
      try {
        // money() throws on an unknown currency code or a non-integer minor
        // amount. Attacker-controlled input (an injected listing, a tool
        // result) must be rejected, never allowed to crash the turn.
        parsedMoney = money(BigInt(m.minor), m.currency)
      } catch {
        rejected.push(key)
        continue
      }
      const existing = (current.budget?.value ?? null)
      if (existing && existing.currency !== parsedMoney.currency) {
        rejected.push(key)          // never coerce currencies
        continue
      }
      value = parsedMoney
    }

    if ((CONSTRAINT_FIELDS as readonly string[]).includes(key) && source !== 'user') {
      const currentField = (current as unknown as Record<string, { value: unknown } | null>)[key]
      if (relaxes(key, currentField?.value, value)) {
        rejected.push(key)          // the injection defence
        continue
      }
    }

    ;(next as never as Record<string, unknown>)[key] = { value, source, at }
  }

  return { next, rejected: [...new Set(rejected)] }
}
