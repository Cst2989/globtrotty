import type postgres from 'postgres'
import { PRICES } from '../pricing.js'
import type { Seat } from '../seats.js'

/**
 * An UPPER BOUND on what a call may cost, computed before it is dispatched.
 *
 * SPEC section 8: the cost of a call is known only after the response, so a
 * design that only ever checks what was already spent cannot bound the call it
 * is about to make. `recordSpend` (src/repo/spend.ts) runs after each call and
 * is honest about what happened; it has nothing to say about what is about to.
 * Until this lesson the harness read the counters once per agent step and a step
 * was the whole of `turn()`, so a dozen model calls ran behind one reading. We
 * debit the bound first and reconcile after.
 *
 * The bound assumes the worst realistic case: every input token billed at the
 * most expensive rate the request could be billed at, plus a full `max_tokens`
 * of output. That rate is now `cacheWrite1hMult`, and the multiplier below says
 * why in full.
 *
 * `Math.max(..., 1)` is there so a future price whose cache write multiplier
 * somehow drops below list does not LOWER the bound under plain list price.
 *
 * Rounded up with `Math.ceil` before the `BigInt` conversion for two reasons: a
 * guardrail must never undercount, and `BigInt()` throws a RangeError on a non
 * integer rather than truncating, so an un-rounded value would crash the
 * pre-dispatch path outright.
 */
export function estimateMicros(seat: Seat, inputTokens: number): bigint {
  const p = PRICES[seat.model]
  if (!p) throw new Error(`No price for model "${seat.model}". Refusing to reserve zero.`)
  // The highest multiplier any input token can be billed at. TWICE list, not
  // 1.25 times: from this lesson every driver and scout request carries a 1h
  // cache TTL on its system head (SYSTEM_CACHE_TTL, src/model/cache.ts), and a
  // 1h cache WRITE is a PREMIUM rather than a discount, because the provider
  // bills the write in addition to the tokens it stores. A cold cache, the
  // first call of a conversation or any call resumed past the hour, reports
  // those tokens back as cache_creation_input_tokens at that rate. Lesson 5.1's
  // version bounded at 1.25 and said in as many words that this line had to
  // move with the TTL; a bound that can undercount is not a bound, and it is
  // the guardrail rather than the ledger that would have been wrong, because
  // reconcile charges the true figure either way.
  const worstCaseInputMult = Math.max(p.cacheWrite1hMult, 1)
  const micros =
    inputTokens * p.inMicrosPerToken * worstCaseInputMult + seat.maxTokens * p.outMicrosPerToken
  return BigInt(Math.ceil(micros))   // round UP: a bound must never undercount
}

/**
 * The bound for a whole fan-out, taken once, before any of its calls is made.
 *
 * `estimateMicros` bounds one call, and `n` copies of a per-call check is not a
 * bound on `n` calls: three calls dispatched together each read a counter the
 * other two have not moved yet, so a conversation with room for two admits all
 * three and the ceiling is crossed by a whole call. Reserving `n` times the
 * per-call bound in ONE debit is what makes the check see the whole batch.
 *
 * Multiplied in bigint rather than in the number that feeds `estimateMicros`,
 * so the rounding-up happens per call. `Math.ceil(x) * n` and `Math.ceil(x * n)`
 * differ by up to `n - 1` micros, which is nothing, and the first is the one
 * that is a bound on `n` separately-rounded calls rather than on a hypothetical
 * single call of `n` times the size.
 */
export function estimateBatchMicros(seat: Seat, inputTokens: number, n: number): bigint {
  if (n < 1) throw new Error(`estimateBatchMicros: n must be at least 1, got ${n}`)
  return estimateMicros(seat, inputTokens) * BigInt(n)
}

/**
 * Debits the reservation and returns the NEW conversation total, plus the day
 * and the new daily total the reservation landed on. The caller's ceiling check
 * must compare against the values RETURNED here: reading either counter before
 * the turn began is exactly the staleness the reserve-before-call design exists
 * to remove.
 *
 * This is the THIRD writer of `course.conversations.spend_usd_micros` and
 * `course.daily_usage.cost_micros`, after `recordSpend` (lesson 2.6) and
 * `reconcile` below is the fourth. `src/repo/spend.ts`'s docstring, which said
 * `recordSpend` was the only one, is corrected in this same commit; a comment
 * that names one writer where there are four is the defect class LESSONS.md
 * calls the worst one.
 *
 * The day boundary is UTC, spelled `(now() at time zone 'utc')::date` and never
 * `current_date`, for the reason src/repo/spend.ts gives at length: this
 * project's vitest config pins a non-UTC zone, a pooler can hand out a session
 * configured by somebody else, and a writer and a reader that disagree about
 * "today" mean the daily and global ceilings quietly stop counting.
 *
 * The returned `day` is not decorative. `reconcile` must be called with it
 * rather than recomputing today, because a driver call with extended thinking in
 * flight can straddle UTC midnight between the two.
 */
export async function reserve(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; micros: bigint },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint; day: string }> {
  return await sql.begin(async (tx) => {
    const rows = await tx<{ spend_usd_micros: string }[]>`
      update course.conversations
         set spend_usd_micros = spend_usd_micros + ${args.micros.toString()},
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reserve: conversation ${args.conversationId} not found for this user`)
    }
    const daily = await tx<{ day: string; cost_micros: string }[]>`
      insert into course.daily_usage (user_id, day, cost_micros)
      values (${args.userId}, (now() at time zone 'utc')::date, ${args.micros.toString()})
      on conflict (user_id, day) do update
        set cost_micros = course.daily_usage.cost_micros + excluded.cost_micros,
            updated_at = now()
      returning day::text as day, cost_micros`
    if (daily.length === 0) throw new Error('reserve: daily_usage upsert wrote no row')
    return {
      conversationMicros: BigInt(rows[0]!.spend_usd_micros),
      dailyMicros: BigInt(daily[0]!.cost_micros),
      day: daily[0]!.day,
    }
  }) as unknown as { conversationMicros: bigint; dailyMicros: bigint; day: string }
}

/**
 * Applies the signed difference between what was reserved and what the call
 * actually cost. Normally a REFUND, because the reservation assumes a full
 * `max_tokens` of output that most responses never reach.
 *
 * `args.day` MUST be the `day` `reserve` returned for this same reservation and
 * is never derived from "today" here. Recomputing it is correct only while both
 * calls land on the same UTC day and silently wrong, in the undercounting
 * direction, the moment they do not: a refund would be subtracted from a
 * different day's total than the one it was reserved against, by up to a whole
 * driver reservation. Taking the day as an argument removes the possibility
 * structurally, because there is no "today" left here to disagree with.
 *
 * Clamped at zero in the SQL expression itself, with `greatest(0, ...)`, rather
 * than by reading, clamping and writing back: both columns carry a `>= 0` check
 * constraint, a refund larger than the balance can only mean a bug upstream, and
 * a read-clamp-write would leave a race window. Failing the turn on the
 * constraint violation would turn an accounting bug into a lost turn; clamping
 * keeps the ceiling alive and leaves the bug visible in course.model_calls,
 * which records what was really spent.
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
      update course.conversations
         set spend_usd_micros = greatest(0, spend_usd_micros + ${delta.toString()}),
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reconcile: conversation ${args.conversationId} not found for this user`)
    }
    const daily = await tx<{ cost_micros: string }[]>`
      insert into course.daily_usage (user_id, day, cost_micros)
      values (${args.userId}, ${args.day}, greatest(0, ${delta.toString()}::bigint))
      on conflict (user_id, day) do update
        set cost_micros = greatest(0, course.daily_usage.cost_micros + ${delta.toString()}),
            updated_at = now()
      returning cost_micros`
    if (daily.length === 0) throw new Error('reconcile: daily_usage upsert wrote no row')
    return {
      conversationMicros: BigInt(rows[0]!.spend_usd_micros),
      dailyMicros: BigInt(daily[0]!.cost_micros),
    }
  }) as unknown as { conversationMicros: bigint; dailyMicros: bigint }
}
