import { z } from 'zod'
import { compareMoney, formatMoney, money, type Money } from './money.js'

/** Who wrote a field: she did, we inferred it, or a tool returned it. */
export type Provenance = 'user' | 'inferred' | 'tool'
export type Field<T> = { value: T; source: Provenance; at: string } | null

export type Notebook = {
  budget: Field<Money>
  destination: Field<string>
  originCity: Field<string>
  nights: Field<number>
  month: Field<string>
  partySize: Field<{ adults: number; children: number; infants: number }>
  nearBeach: Field<boolean>
  needsCrib: Field<boolean>
}

/**
 * Fields nothing but her own words may loosen: a search result cannot raise her
 * budget or lengthen her trip.
 */
export const CONSTRAINT_FIELDS = ['budget', 'nights'] as const

export function emptyNotebook(): Notebook {
  return { budget: null, destination: null, originCity: null, nights: null, month: null, partySize: null, nearBeach: null, needsCrib: null }
}

/**
 * What a budget looks like on the WIRE, which is not what it looks like in
 * memory. The tool description tells the model to send `{minor, currency}` and
 * the model sends whatever JSON it composed, so `minor` arrives as a string
 * ("150000"), as a number (150000), or, from `src/conversation.ts`'s extraction
 * path, as the bigint of a Money this process built itself. `money()` below
 * decides which of those is a budget and which is not.
 */
const MoneyIn = z.object({
  minor: z.union([z.string(), z.number(), z.bigint()]),
  currency: z.string(),
})

/**
 * The shape of a patch, enforced rather than described, and the reason it is
 * here rather than in the published tool schema (src/tools/registry.ts).
 *
 * The registry publishes `patch` as a free record on purpose: the API's JSON
 * schema is what the MODEL reads, and a per-field schema there would still be
 * advice. This is the check, it runs on the way into the one function that
 * writes the notebook, and it therefore covers every caller, the extraction path
 * in `src/conversation.ts` included.
 *
 * `strictObject`, so an invented key is refused rather than written: the column
 * is jsonb and keeps whatever it is given, and `renderNotebook`
 * (src/repo/notebook.ts) refuses to PRINT a key the current shape does not
 * declare but cannot unwrite one. Every string is bounded for the same reason
 * the whole notebook is: it is rendered into the model's context on every step
 * of every later turn, so an unbounded value under a real key is untrusted text
 * riding in the suffix forever, and a runaway one is megabytes of jsonb read on
 * every step.
 */
const PatchSchema = z.strictObject({
  budget: MoneyIn.optional(),
  destination: z.string().min(1).max(120).optional(),
  originCity: z.string().min(1).max(120).optional(),
  nights: z.int().min(1).max(60).optional(),
  month: z.string().min(1).max(40).optional(),
  partySize: z.object({
    adults: z.int().min(1).max(9),
    children: z.int().min(0).max(9),
    infants: z.int().min(0).max(9),
  }).optional(),
  nearBeach: z.boolean().optional(),
  needsCrib: z.boolean().optional(),
})

function relaxes(field: (typeof CONSTRAINT_FIELDS)[number], current: Notebook, next: unknown): boolean {
  const existing = current[field]
  if (!existing) return false
  if (field === 'budget') {
    const a = next as Money
    const b = existing.value as Money
    // A tool that answers in another currency cannot be compared with her
    // budget, so it is refused rather than converted. Converting is a decision
    // someone has to take on purpose, and a hotel search is not that someone.
    // Reached in production from lesson 5.2: `update_requirements` goes through
    // `applyRequirementsPatch` (src/repo/notebook.ts) with the provenance
    // `provenanceFor` (src/agents/driver.ts) derived from the transcript, so a
    // patch the model composed after reading a supplier result arrives as
    // 'inferred' rather than as her words.
    if (a.currency !== b.currency) return true
    return compareMoney(a, b) === 1
  }
  return (next as number) > (existing.value as number)
}

/**
 * Writes a patch into the notebook with its provenance, and names what it
 * refused. Her own words win over anything we inferred, and a tool can tighten a
 * constraint but never relax one, because a hotel that costs more must not
 * become her budget.
 *
 * `rejected` is new at lesson 5.2 and it is the reason the return type changed:
 * `update_requirements` answers the model, and a model told "recorded" after a
 * silent refusal re-sends the same value next step. Naming the keys that were
 * refused lets it ask her instead.
 *
 * ## Why `patch` is `unknown`
 *
 * Because it is. It is a JSON object a model composed, published to it as a free
 * record (src/tools/registry.ts), handed through `validateToolCall` untouched
 * and into `applyRequirementsPatch` (src/repo/notebook.ts), which writes it into
 * a jsonb column every later turn reads. Typing the parameter as the shape we
 * WANT would have made the compiler agree with us about a value nothing had
 * checked. `PatchSchema` is what makes the shape true, and it runs here, before
 * the value can reach `toStored`.
 *
 * A patch that fails the schema is refused WHOLESALE rather than field by field:
 * a patch that is partly invented is a patch there is no reason to trust the
 * rest of, and `rejected` still names every offending key, so the model is told
 * what to fix rather than left to guess. Nothing throws on any input, because a
 * throw here kills a turn the model could have corrected in one step.
 */
export function applyRequirements(
  current: Notebook, patch: unknown, source: Provenance, at: string,
): { next: Notebook; rejected: string[] } {
  const parsed = PatchSchema.safeParse(patch)
  if (!parsed.success) {
    // zod reports an unrecognised key on `issue.keys` with an empty path, and a
    // bad value for a known field on `issue.path`.
    const refused: string[] = []
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') refused.push(...issue.keys)
      else refused.push(String(issue.path[0] ?? 'unknown'))
    }
    return { next: current, rejected: [...new Set(refused)] }
  }

  const next: Notebook = { ...current }
  const rejected: string[] = []
  for (const [key, raw] of Object.entries(parsed.data) as [keyof Notebook, unknown][]) {
    if (raw === undefined || raw === null) continue
    let value = raw
    if (key === 'budget') {
      const wire = raw as z.infer<typeof MoneyIn>
      try {
        // `money()` throws on an unknown currency code and on minor units that
        // are not a whole number, and BOTH are reachable without an adversary:
        // a model that reasons in whole euros writes 1500 as `1.5e3`, and
        // `BigInt('1.5e3')` throws. Stored verbatim that value passes
        // `renderNotebook` and then fails `fromStored` on every subsequent read,
        // so `loadNotebook` throws at the top of every driver step and the
        // conversation is dead on every retry until someone edits the row.
        // Attacker-controlled input, an injected listing or a tool result, must
        // be rejected here and never allowed to crash a turn or outlive one.
        value = money(BigInt(wire.minor), wire.currency)
      } catch {
        rejected.push(key)
        continue
      }
    }
    const existing = current[key]
    if (existing && existing.source === 'user' && source !== 'user') { rejected.push(key); continue }
    // Any source that is not hers, and not only 'tool'. Widened at lesson 5.2,
    // when this rule got its first production caller. `provenanceFor`
    // (src/agents/driver.ts) stamps a patch 'user' or 'inferred' and never
    // 'tool', because the harness decides provenance from the transcript rather
    // than from which layer called; a guard that named one of the three would
    // have gone on defending nothing while the module claimed it did. The guard
    // above catches a non-user patch against a field SHE set, so what reaches
    // this line is a constraint nobody stated being loosened by something we
    // worked out, which is the case CONSTRAINT_FIELDS exists for.
    if (source !== 'user'
        && (CONSTRAINT_FIELDS as readonly string[]).includes(key)
        && relaxes(key as (typeof CONSTRAINT_FIELDS)[number], current, value)) {
      rejected.push(key)
      continue
    }
    ;(next as Record<string, unknown>)[key] = { value, source, at }
  }
  return { next, rejected }
}

function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'minor' in value && 'currency' in value) {
    return formatMoney(value as Money)
  }
  return JSON.stringify(value)
}

export function notebookForPrompt(notebook: Notebook): string {
  const lines = Object.entries(notebook)
    .filter(([, field]) => field !== null)
    .map(([key, field]) => `${key}: ${describeValue((field as { value: unknown }).value)} (${(field as { source: string }).source})`)
  return lines.length ? lines.join('\n') : 'nothing yet'
}

/**
 * The notebook as jsonb, and back. Two columns hold this shape:
 * `course.conversations.requirements` (migration 0015) and, from lesson 6.2,
 * `course.proposals.requirements_snapshot` (migration 0018). One serialiser for
 * both, kept here beside the `Notebook` it converts rather than beside either
 * reader, because a second serialiser written next to the second column is how
 * the two come to disagree about what a stored budget looks like.
 *
 * ## Why it is not a bare `update ... set requirements = $1`
 *
 * `Money.minor` is a bigint and `JSON.stringify` throws on a bigint, which is
 * what postgres.js's `sql.json` calls. So the budget field is stored with
 * `minor` as a decimal string and rebuilt through `money()` on the way out,
 * which also re-validates the currency code against a notebook an older version
 * of this code could have written. `Money`'s brand is a symbol key, so
 * `JSON.stringify` drops it and `money()` restores it at no cost.
 */
type StoredField = { value: unknown; source: Provenance; at: string } | null

/** The notebook on its way into a jsonb column. */
export function toStored(nb: Notebook): Record<string, unknown> {
  const budget: StoredField = nb.budget === null ? null : {
    value: { minor: nb.budget.value.minor.toString(), currency: nb.budget.value.currency },
    source: nb.budget.source, at: nb.budget.at,
  }
  return { ...nb, budget }
}

/**
 * The inverse, and the ONE reader of both columns. `loadProposal`
 * (src/repo/proposals.ts) reads a snapshot out of course.proposals and
 * `loadNotebook` (src/repo/notebook.ts) reads the live notebook out of
 * course.conversations, and a gate replayed through a second parser would be
 * judging a different notebook from the one production judged.
 */
export function fromStored(raw: unknown): Notebook {
  const base = emptyNotebook()
  if (raw === null || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const out: Notebook = { ...base, ...(r as Partial<Notebook>) }
  const b = r.budget as
    { value?: { minor?: unknown; currency?: unknown }; source?: unknown; at?: unknown } | null
  out.budget =
    b && b.value && typeof b.value.currency === 'string' && b.value.minor !== undefined
      ? {
          value: money(BigInt(String(b.value.minor)), b.value.currency),
          source: b.source as Provenance, at: String(b.at),
        }
      : null
  return out
}
