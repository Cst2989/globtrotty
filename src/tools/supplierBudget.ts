import type postgres from 'postgres'

/**
 * The tools that reach a metered, rate-limited third party. Kept here rather
 * than derived from TOOLS' `door` field so the budget cannot silently widen
 * when a new tool is added: adding an api-door tool must be a deliberate edit
 * to this list.
 */
export const SUPPLIER_DOORS: readonly string[] = ['explore_flights', 'explore_hotels']

/**
 * Spec section 8: "Supplier APIs are rate-limited and sometimes metered, and v1
 * counted them nowhere."
 *
 * Counts from `tool_calls`, which src/worker.ts's loop() writes BEFORE every
 * execution (beginToolCall, plan 1), so the count includes a call that started
 * and died mid-flight. That is the correct
 * bias for a rate limit: an attempt consumed the quota whether or not we saw
 * the answer.
 *
 * Throws rather than returning 0 when the read fails. A supplier budget is a
 * guardrail, and `?? 0` here would turn "I cannot confirm how many calls we
 * have made" into "none", lifting the cap exactly when the database is
 * unhealthy.
 */
export async function countSupplierCalls(sql: postgres.Sql, turnId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from tool_calls
     where turn_id = ${turnId} and name = any(${SUPPLIER_DOORS as string[]})`
  const row = rows[0]
  if (!row) throw new Error('countSupplierCalls: count returned no row; refusing to assume zero')
  return row.n
}

export async function assertSupplierBudget(
  sql: postgres.Sql, turnId: string, max: number,
): Promise<{ ok: true } | { ok: false; used: number; max: number }> {
  const used = await countSupplierCalls(sql, turnId)
  return used >= max ? { ok: false, used, max } : { ok: true }
}
