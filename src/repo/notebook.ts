import type postgres from 'postgres'
import { formatMoney, money } from '../money.js'
import { applyRequirements, emptyNotebook, type Notebook, type Provenance } from '../notebook.js'
import { escapeFence } from '../tools/validate.js'

/**
 * `course.conversations.requirements` arrived in migration 0015 for this module,
 * and this module is its only reader and its only writer.
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

function toStored(nb: Notebook): Record<string, unknown> {
  const budget: StoredField = nb.budget === null ? null : {
    value: { minor: nb.budget.value.minor.toString(), currency: nb.budget.value.currency },
    source: nb.budget.source, at: nb.budget.at,
  }
  return { ...nb, budget }
}

function fromStored(raw: unknown): Notebook {
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

export async function loadNotebook(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<Notebook> {
  const rows = await sql<{ requirements: unknown }[]>`
    select requirements from course.conversations
     where id = ${conversationId} and user_id = ${userId}`
  const row = rows[0]
  // Never an empty notebook on a missed read: an absent row means the wrong user
  // or a deleted conversation, and silently planning against a blank notebook
  // would discard every constraint she gave us. A row whose column is null is a
  // different case and legitimately reads as empty.
  if (!row) throw new Error(`loadNotebook: conversation ${conversationId} not found for this user`)
  return fromStored(row.requirements)
}

/**
 * Read, modify and write under `for update`, in one transaction.
 *
 * The lock is what makes the provenance guard real. `applyRequirements` decides
 * whether a patch may relax a constraint by comparing it against the CURRENT
 * value, and a read outside the transaction could compare against a value
 * another writer has already replaced, so two concurrent relaxations would both
 * pass and the later write would win with a number the guard exists to refuse.
 *
 * `source` is the caller's and never the model's: the tool schema has no field
 * for it (src/tools/registry.ts), and `provenanceFor` (src/agents/driver.ts)
 * derives it from the transcript. Only user-message-derived changes may relax a
 * constraint.
 *
 * `at` is threaded in rather than read from a clock here, so a test can state
 * the moment and the notebook's timestamps are the harness's one clock rather
 * than this file's own.
 *
 * The write is verified through `returning`, like every writer on this branch: a
 * notebook write that touched no row is not a smaller success, it is a patch
 * that reached nobody's conversation.
 */
export async function applyRequirementsPatch(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; patch: unknown; source: Provenance; at: string },
): Promise<{ next: Notebook; rejected: string[] }> {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ requirements: unknown }[]>`
      select requirements from course.conversations
       where id = ${args.conversationId} and user_id = ${args.userId}
       for update`
    const row = rows[0]
    if (!row) {
      throw new Error(
        `applyRequirementsPatch: conversation ${args.conversationId} not found for this user`,
      )
    }
    // `args.patch` goes in as the `unknown` it is: `applyRequirements`
    // (src/notebook.ts) parses it against `PatchSchema` and coerces the budget
    // through `money()` before anything here can reach `toStored`, which is what
    // keeps a value the model invented out of this column.
    const { next, rejected } = applyRequirements(
      fromStored(row.requirements), args.patch, args.source, args.at,
    )
    const written = await tx`
      update course.conversations
         set requirements = ${tx.json(toStored(next) as never)}, updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning id`
    if (written.length === 0) {
      throw new Error(`applyRequirementsPatch: wrote no row for ${args.conversationId}`)
    }
    return { next, rejected }
  }) as unknown as { next: Notebook; rejected: string[] }
}

/**
 * The notebook as text for the model. Rendered into `CallArgs.suffix`
 * (src/model/client.ts), which lands after the last block of the transcript and,
 * from lesson 5.6, after the last cache breakpoint. It is kept out of the system
 * prompt for that reason: the prompt is the stable prefix, the notebook changes
 * the moment she states a fact, and anything cached behind it would be thrown
 * away on every request.
 *
 * Provenance is shown, because the model has to know which values it may not
 * quietly widen. The budget carries its ISO currency code beside the formatted
 * amount: `formatMoney` renders a symbol, and the model has to send
 * `{minor, currency}` back through `update_requirements`, where a symbol is not
 * a currency code `money()` accepts.
 */
export function renderNotebook(nb: Notebook): string {
  const lines: string[] = []
  // Only keys the CURRENT Notebook shape declares. `fromStored` spreads whatever
  // the jsonb column holds, and the column is writable, so a key written by an
  // older version of this code must not be printed into the model's context as
  // though the office recorded it.
  const shape = emptyNotebook()
  for (const [key, field] of Object.entries(nb)) {
    if (!(key in shape)) continue
    if (field === null) continue
    const f = field as { value: unknown; source: Provenance }
    const shown = key === 'budget'
      ? `${formatMoney(f.value as Parameters<typeof formatMoney>[0])} `
        + `${(f.value as { currency: string }).currency}`
      : JSON.stringify(f.value)
    // The same `escapeFence` the fence uses (src/tools/validate.ts), and for the
    // same reason. The notebook is OURS and is therefore not fenced, but it
    // rides in the SAME request as a fenced tool result, and a value that closes
    // a fence closes the fence printed above it. The value is a string the model
    // wrote through `update_requirements` after reading a listing, so "ours" is
    // a fact about the column and not about who chose the characters.
    lines.push(`- ${key}: ${escapeFence(shown)} (${f.source})`)
  }
  return lines.length === 0 ? '' : `## The notebook, as recorded\n\n${lines.join('\n')}`
}
