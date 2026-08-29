import type postgres from 'postgres'
import { applyRequirements, emptyNotebook, type Notebook, type Provenance } from '../notebook.js'
import { formatMoney, money } from '../money.js'

/**
 * `conversations.requirements` has existed since migration 0001 with no reader
 * and no writer. This module is both.
 *
 * ## Why it is not a bare `update ... set requirements = $1`
 *
 * `Money.minor` is a **bigint**, and `JSON.stringify` throws on a bigint — which
 * postgres.js's `sql.json` calls. So the budget field is stored with `minor` as a
 * decimal string and rebuilt through `money()` on the way out, which also
 * re-validates the currency code against a notebook that could have been written
 * by an older version of this code. `Money`'s brand is a symbol key, so it is
 * dropped by `JSON.stringify` and restored by `money()` for free.
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
    select requirements from conversations
     where id = ${conversationId} and user_id = ${userId}`
  const row = rows[0]
  // Never an empty notebook on a missed read: an absent row means the wrong
  // user or a deleted conversation, and silently planning against a blank
  // notebook would discard every constraint she gave us.
  if (!row) throw new Error(`loadNotebook: conversation ${conversationId} not found for this user`)
  return fromStored(row.requirements)
}

/**
 * Read-modify-write under `for update`, in one transaction.
 *
 * The lock is what makes the provenance guard real: `applyRequirements` decides
 * whether a patch may relax a constraint by comparing it against the CURRENT
 * value, and a read outside the transaction could compare against a value another
 * writer has already replaced.
 *
 * `source` is the caller's, never the model's — the tool schema has no field for
 * it (src/tools/registry.ts). Spec section 4: only user-message-derived changes
 * may relax a constraint.
 */
export async function applyRequirementsPatch(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; patch: unknown; source: Provenance },
): Promise<{ next: Notebook; rejected: string[] }> {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ requirements: unknown }[]>`
      select requirements from conversations
       where id = ${args.conversationId} and user_id = ${args.userId}
       for update`
    const row = rows[0]
    if (!row) {
      throw new Error(
        `applyRequirementsPatch: conversation ${args.conversationId} not found for this user`,
      )
    }
    const { next, rejected } =
      applyRequirements(fromStored(row.requirements), args.patch, args.source)
    const written = await tx`
      update conversations
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
 * The notebook as text for the model. Rendered into `CallArgs.suffix`, which
 * lands AFTER the last cache breakpoint — it changes every turn, and anything
 * cached behind it would be invalidated on every request (spec section 7).
 *
 * Provenance is shown, because the model has to know which values it may not
 * quietly widen. The budget carries its ISO currency CODE alongside the
 * formatted amount: `formatMoney` renders a symbol ("€1,500.00"), and the model
 * has to send `{minor, currency}` back through `update_requirements`, where a
 * symbol is not a currency code `money()` accepts.
 */
export function renderNotebook(nb: Notebook): string {
  const lines: string[] = []
  for (const [key, field] of Object.entries(nb)) {
    if (field === null) continue
    const f = field as { value: unknown; source: Provenance }
    const shown = key === 'budget'
      ? `${formatMoney(f.value as Parameters<typeof formatMoney>[0])} `
        + `${(f.value as { currency: string }).currency}`
      : JSON.stringify(f.value)
    lines.push(`- ${key}: ${shown} (${f.source})`)
  }
  return lines.length === 0 ? '' : `## The notebook, as recorded\n\n${lines.join('\n')}`
}
