import type postgres from 'postgres'
import { PRICES } from '../pricing.js'
import type { Seat } from '../model/seats.js'

/**
 * An UPPER BOUND on what a call may cost, computed before dispatch.
 *
 * Spec section 8: cost is known only after the response, so a check-only design
 * cannot be tight — v1 added spend once at turn end and a runaway 12-step turn
 * passed the same stale check a dozen times. We debit the bound first and
 * reconcile after.
 *
 * The bound assumes the worst realistic case: every input token billed at the
 * most expensive rate the request could possibly be billed at, plus a full
 * `max_tokens` of output. "Most expensive rate" is NOT list price — every
 * driver call writes `system` + `tools` at a 1h cache TTL (`SYSTEM_CACHE_TTL`,
 * src/model/cache.ts), and `pricing.ts`'s own table prices a 1h cache WRITE at
 * `cacheWrite1hMult` (2x) list, because the provider bills the write itself in
 * addition to the tokens it stores. A cold cache — the first call of a
 * conversation, or any call resumed past the 1h window — reports those tokens
 * back as `cache_creation_input_tokens`, not `input_tokens`, at that 2x rate.
 * An earlier version of this function priced the input term at plain list
 * (`p.inMicrosPerToken`, no multiplier) and called that "no cache discount" —
 * true of a cache READ (which is a 0.1x DISCOUNT), false of a cache WRITE
 * (which is a PREMIUM), so on a cold cache `actual` could exceed `reserved` by
 * `inputTokens * p.inMicrosPerToken * (cacheWrite1hMult - 1)` micros — real
 * money the pre-dispatch ceiling check never saw. `Math.max(p.cacheWrite1hMult,
 * 1)` closes that: it is the highest multiplier any input token can be billed
 * at (2x list beats every other rate in the table — 1.25x 5m-write, 0.1x
 * read, 1x plain), so bounding every input token at it is a real upper bound
 * again — a LARGER number than "list price" ever was, which is the whole
 * point: the old bound was too small to be a bound. `reconcile` charges the
 * true `actual` regardless, so the ledger was never wrong — only the
 * pre-dispatch guardrail was, and the guardrail is the thing this bound exists
 * to be.
 *
 * Real calls almost always cost less than this bound, so `reconcile` usually
 * refunds.
 *
 * Rounded UP with `Math.ceil` before the `BigInt` conversion for two reasons,
 * not one: a guardrail must never undercount, AND `BigInt()` does not truncate
 * a non-integer — `BigInt(1.5)` throws a `RangeError`. If a price is ever added
 * whose per-token rate is fractional (every multiplier in `costMicros` already
 * is: 1.25x, 2x, 0.1x), an un-rounded `micros` here would crash the pre-dispatch
 * path outright, not just misprice it.
 */
export function estimateMicros(seat: Seat, inputTokens: number): bigint {
  const p = PRICES[seat.model]
  if (!p) throw new Error(`No price for model "${seat.model}". Refusing to reserve zero.`)
  // Math.max(..., 1): a future price whose cache-write multiplier somehow
  // drops below 1x list must not LOWER the bound below plain list price either.
  const worstCaseInputMult = Math.max(p.cacheWrite1hMult, 1)
  const micros =
    inputTokens * p.inMicrosPerToken * worstCaseInputMult + seat.maxTokens * p.outMicrosPerToken
  return BigInt(Math.ceil(micros))   // round UP: a bound must never undercount
}

/**
 * Debits the reservation and returns the NEW conversation total, plus the day
 * and new daily total the reservation landed on. The caller's ceiling check
 * must compare against the returned `conversationMicros`/`dailyMicros` —
 * reading either counter before the turn began is exactly the staleness spec
 * section 8 names.
 *
 * daily_usage is written in the same statement group, on a UTC day boundary
 * (`(now() at time zone 'utc')::date`, never `current_date`, which is
 * session-timezone dependent and can bucket the writer and reader into
 * different days). The returned `day` is not decorative: `reconcile` must be
 * called with it rather than recomputing "today", because a long driver call
 * (extended thinking included) can straddle UTC midnight between `reserve` and
 * `reconcile` — see the doc comment on `reconcile` for what goes wrong if it
 * recomputes instead.
 */
export async function reserve(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; micros: bigint },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint; day: string }> {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ spend_usd_micros: string }[]>`
      update conversations
         set spend_usd_micros = spend_usd_micros + ${args.micros.toString()},
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reserve: conversation ${args.conversationId} not found for this user`)
    }
    const daily = await tx<{ day: string; cost_micros: string }[]>`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, (now() at time zone 'utc')::date, ${args.micros.toString()})
      on conflict (user_id, day) do update
        set cost_micros = daily_usage.cost_micros + excluded.cost_micros,
            updated_at = now()
      returning day::text as day, cost_micros`
    return {
      conversationMicros: BigInt(rows[0]!.spend_usd_micros),
      dailyMicros: BigInt(daily[0]!.cost_micros),
      day: daily[0]!.day,
    }
  })
}

/**
 * Applies the signed difference between what was reserved and what the call
 * actually cost. Normally a REFUND, because the reservation assumes a full
 * max_tokens of output that most responses never reach.
 *
 * `args.day` MUST be the `day` `reserve` returned for this same reservation,
 * not a value this function derives from "today". An earlier version of this
 * file recomputed `(now() at time zone 'utc')::date` here instead, which is
 * correct only when `reserve` and `reconcile` land on the same UTC day — and
 * silently WRONG, in the undercounting direction, the moment they don't:
 *   - Charge case, no row yet for "today": the conversation total is still
 *     correctly updated (it isn't day-bucketed), but the daily upsert's INSERT
 *     branch fires with a bare `0`, so the charge's delta is dropped from
 *     daily_usage entirely — the two counters diverge permanently.
 *   - Refund case, no row yet for "today": same INSERT branch, same dropped
 *     delta, plus a spurious zero row left behind for a day nothing happened on.
 *   - Refund case where "today" already has an unrelated row: the refund is
 *     subtracted from a DIFFERENT day's total than the one it was reserved
 *     against, undercounting that day by up to the full reservation.
 * In the common case `reserve` creates today's row moments before `reconcile`
 * runs, which is exactly why this bug hid: it only bites when the UTC day
 * rolls over between the two calls, e.g. a driver call with extended thinking
 * in flight across midnight UTC — up to ~400,000 micros per crossing for a
 * driver seat. Taking `day` as an argument instead of recomputing it removes
 * the possibility structurally: there is no "today" left to disagree with.
 *
 * Clamped at zero: `conversations.spend_usd_micros` and `daily_usage.cost_micros`
 * both carry a `>= 0` check constraint, and a refund larger than the balance can
 * only mean a bug upstream. Aborting the turn on a constraint violation would
 * turn an accounting bug into a lost turn; clamping (via SQL `greatest(0, ...)`
 * inside the `SET`/`INSERT` expression itself, not a JS read-clamp-write) keeps
 * the ceiling alive, leaves no race window, and leaves the bug visible in the
 * ledger, where model_calls records what was really spent.
 */
export async function reconcile(
  sql: postgres.Sql,
  args: {
    userId: string; conversationId: string; reserved: bigint; actual: bigint; day: string
  },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  const delta = args.actual - args.reserved
  return await sql.begin(async (tx) => {
    const rows = await tx<{ spend_usd_micros: string }[]>`
      update conversations
         set spend_usd_micros = greatest(0, spend_usd_micros + ${delta.toString()}),
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reconcile: conversation ${args.conversationId} not found for this user`)
    }
    const daily = await tx<{ cost_micros: string }[]>`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, ${args.day}, greatest(0, ${delta.toString()}::bigint))
      on conflict (user_id, day) do update
        set cost_micros = greatest(0, daily_usage.cost_micros + ${delta.toString()}),
            updated_at = now()
      returning cost_micros`
    return {
      conversationMicros: BigInt(rows[0]!.spend_usd_micros),
      dailyMicros: BigInt(daily[0]!.cost_micros),
    }
  })
}
