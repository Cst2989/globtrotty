import type postgres from 'postgres'

/**
 * The most cities one `research_destination` call may fan out to, which is the
 * `cities: z.array(...).max(3)` the registry publishes (src/tools/registry.ts)
 * and `test/registry.test.ts` is where the two are kept agreeing.
 *
 * It lives here as well as there because the budget below needs a number for a
 * fan-out it can no longer read the input of: see `SUPPLIER_CALL_COST`.
 */
export const SCOUT_MAX_CITIES = 3

/**
 * What one call of each tool costs the per-turn supplier budget, for the tools
 * that reach a metered, rate-limited third party.
 *
 * Kept here as a hand-written map rather than derived from the registry's
 * `door === 'api'` so the budget cannot silently widen when a tool is added:
 * pricing a tool has to be a deliberate edit to these lines, and
 * `test/registry.test.ts` is where a disagreement between the two shows up.
 *
 * `research_destination` is the entry that is NOT an api door, and it is the
 * reason this is a map rather than a list. A fan-out searches the hotel supplier
 * once per city, directly (`cityPayload`, src/tools.ts), so three cities is
 * three metered searches; it stands behind a `worker` door, so the door check
 * alone would never have looked at it; and it writes no `course.tool_calls` row
 * per city, because that table keeps exactly one writer and the fan-out is one
 * call. A tool that reaches a supplier without being priced here is a metered
 * third party nothing counts, which is what this file exists to prevent.
 *
 * Three is the registry's CEILING rather than the number of cities the call
 * actually asked for, and that is deliberate. `course.tool_calls` stores the
 * turn, the call id, the name, the status and the result (migration 0006) and
 * no input at all, so a row already in the table cannot say how many cities it
 * was for. Reading it at the ceiling overcounts a one-city fan-out by two,
 * which refuses a search that would have fitted; reading it at one would admit
 * searches the cap was written to refuse. A guardrail rounds the first way.
 * `supplierCallCost` below measures the call about to be made exactly, because
 * the driver holds its input, and that asymmetry is the whole difference
 * between what can be measured and what can only be bounded.
 */
export const SUPPLIER_CALL_COST: Readonly<Record<string, number>> = {
  search_flights: 1,
  search_hotels: 1,
  research_destination: SCOUT_MAX_CITIES,
}

/**
 * What the call about to be made will cost the budget, from the input the model
 * asked with. Zero for every tool that reaches no supplier.
 *
 * The input is UNVALIDATED here: the driver checks the budget before the chain
 * validates anything, so `cities` may be missing, a string, or longer than the
 * schema admits. Anything this cannot read is priced at the ceiling rather than
 * at zero, for `SUPPLIER_CALL_COST`'s reason. A call that really is malformed
 * is rejected one layer down and searches nothing at all, so the worst an
 * overcount does there is refuse a later search in a turn that was already
 * asking for things it cannot have.
 */
export function supplierCallCost(name: string, input: unknown): number {
  if (name !== 'research_destination') return SUPPLIER_CALL_COST[name] ?? 0
  const cities = (input as { cities?: unknown } | null | undefined)?.cities
  if (!Array.isArray(cities)) return SCOUT_MAX_CITIES
  return cities.length >= 1 && cities.length <= SCOUT_MAX_CITIES ? cities.length : SCOUT_MAX_CITIES
}

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
 * Weighted by `SUPPLIER_CALL_COST` rather than counted one per row, because one
 * row is not one supplier call: a `research_destination` row is up to three
 * hotel searches. The weights ride in on `unnest` of two arrays so the map above
 * stays the single place a tool is priced, and the join makes a row nothing
 * prices contribute nothing.
 *
 * Throws rather than returning zero when the read fails. A `?? 0` here would
 * turn "I cannot confirm how many calls we have made" into "none", lifting the
 * cap exactly when the database is unhealthy, which is the same reasoning
 * `readSpendFailClosed` (src/repo/spend.ts) is built on. The aggregate has no
 * `group by`, so it returns exactly one row whatever the table holds, and a
 * missing row means the read itself was wrong rather than that nothing has been
 * searched.
 */
export async function countSupplierCalls(sql: postgres.Sql, turnId: string): Promise<number> {
  const names = Object.keys(SUPPLIER_CALL_COST)
  const costs = Object.values(SUPPLIER_CALL_COST)
  const rows = await sql<{ n: number }[]>`
    select coalesce(sum(priced.cost), 0)::int as n
      from course.tool_calls as call
      join unnest(${names}::text[], ${costs}::int[]) as priced(name, cost)
        on priced.name = call.name
     where call.turn_id = ${turnId}`
  const row = rows[0]
  if (!row) throw new Error('countSupplierCalls: count returned no row; refusing to assume zero')
  return row.n
}

/**
 * Whether this turn may make a call that costs `cost` supplier searches.
 *
 * `cost` rather than a bare "one more", because a fan-out is one tool call and
 * up to three searches, and a budget that asked "is there room for one" would
 * admit three into a turn with room for one. It defaults to 1 so every existing
 * caller reads the same as before: `used + 1 > max` is `used >= max`.
 */
export async function assertSupplierBudget(
  sql: postgres.Sql, turnId: string, max: number, cost = 1,
): Promise<{ ok: true } | { ok: false; used: number; max: number; cost: number }> {
  const used = await countSupplierCalls(sql, turnId)
  return used + cost > max ? { ok: false, used, max, cost } : { ok: true }
}
