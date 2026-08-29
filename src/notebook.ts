import type { Requirements } from './extract.js'
import type { Price } from './supplier/mock.js'

/** Who wrote a field: she did, we inferred it, or a tool returned it. */
export type Provenance = 'user' | 'inferred' | 'tool'
export type Field<T> = { value: T; source: Provenance; at: string } | null

export type Notebook = {
  budget: Field<Price>
  destination: Field<string>
  originCity: Field<string>
  nights: Field<number>
  month: Field<string>
  partySize: Field<{ adults: number; children: number; infants: number }>
  nearBeach: Field<boolean>
  needsCrib: Field<boolean>
}

/** Fields a tool may never loosen: a search result cannot raise her budget or lengthen her trip. */
export const CONSTRAINT_FIELDS = ['budget', 'nights'] as const

export function emptyNotebook(): Notebook {
  return { budget: null, destination: null, originCity: null, nights: null, month: null, partySize: null, nearBeach: null, needsCrib: null }
}

type Patch = Partial<{ [K in keyof Requirements]: NonNullable<Requirements[K]> }>

function relaxes(field: (typeof CONSTRAINT_FIELDS)[number], current: Notebook, next: unknown): boolean {
  const existing = current[field]
  if (!existing) return false
  if (field === 'budget') return (next as Price).amount > (existing.value as Price).amount
  return (next as number) > (existing.value as number)
}

/**
 * Writes a patch into the notebook with its provenance. Her own words win
 * over anything we inferred, and a tool can tighten a constraint but never
 * relax one, because a hotel that costs more must not become her budget.
 */
export function applyRequirements(current: Notebook, patch: Patch, source: Provenance, at: string): Notebook {
  const next: Notebook = { ...current }
  for (const [key, value] of Object.entries(patch) as [keyof Notebook, unknown][]) {
    if (value === undefined || value === null) continue
    const existing = current[key]
    if (existing && existing.source === 'user' && source !== 'user') continue
    if (source === 'tool' && (CONSTRAINT_FIELDS as readonly string[]).includes(key) && relaxes(key as (typeof CONSTRAINT_FIELDS)[number], current, value)) continue
    ;(next as Record<string, unknown>)[key] = { value, source, at }
  }
  return next
}

export function notebookForPrompt(notebook: Notebook): string {
  const lines = Object.entries(notebook)
    .filter(([, field]) => field !== null)
    .map(([key, field]) => `${key}: ${JSON.stringify((field as { value: unknown }).value)} (${(field as { source: string }).source})`)
  return lines.length ? lines.join('\n') : 'nothing yet'
}
