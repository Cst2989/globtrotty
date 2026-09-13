import type postgres from 'postgres'

/**
 * The tools that reach a metered, rate-limited third party. Kept here as a list
 * rather than derived from the registry's `door === 'api'` so the budget cannot
 * silently widen when a tool is added: adding an api-door tool has to be a
 * deliberate edit to this line, and `test/registry.test.ts` is where a
 * disagreement between the two shows up.
 */
export const SUPPLIER_DOORS: readonly string[] = ['search_flights', 'search_hotels']

/**
 * Supplier APIs are rate-limited and sometimes metered, and until this lesson
 * this branch counted them nowhere: a turn could search twelve times inside its
 * step cap.
 *
 * Counts from `course.tool_calls`, which `ledgerRunner` writes BEFORE every
 * execution (`beginToolCall`, lesson 3.4), so the count INCLUDES a call that
 * started and died mid flight. That is the correct bias for a rate limit: an
 * attempt consumed the quota whether or not we saw the answer, and excluding
 * `pending` rows would let a crash-looping turn re-spend the supplier budget
 * from zero on every attempt.
 *
 * Throws rather than returning zero when the read fails. A `?? 0` here would
 * turn "I cannot confirm how many calls we have made" into "none", lifting the
 * cap exactly when the database is unhealthy, which is the same reasoning
 * `readSpendFailClosed` (src/repo/spend.ts) is built on.
 */
export async function countSupplierCalls(sql: postgres.Sql, turnId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from course.tool_calls
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
