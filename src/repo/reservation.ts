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
 * The bound assumes the worst realistic case: every input token billed at list
 * (no cache discount) and a full `max_tokens` of output. Real calls almost
 * always cost less, so `reconcile` usually refunds.
 */
export function estimateMicros(seat: Seat, inputTokens: number): bigint {
  const p = PRICES[seat.model]
  if (!p) throw new Error(`No price for model "${seat.model}". Refusing to reserve zero.`)
  const micros = inputTokens * p.inMicrosPerToken + seat.maxTokens * p.outMicrosPerToken
  return BigInt(Math.ceil(micros))   // round UP: a bound must never undercount
}

/**
 * Debits the reservation and returns the NEW conversation total. The caller's
 * ceiling check must compare against this returned value — reading the counter
 * before the turn began is exactly the staleness spec section 8 names.
 *
 * daily_usage is written in the same statement group, on a UTC day boundary
 * (`(now() at time zone 'utc')::date`, never `current_date`, which is
 * session-timezone dependent and can bucket the writer and reader into
 * different days).
 */
export async function reserve(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; micros: bigint },
): Promise<{ conversationMicros: bigint }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ spend_usd_micros: string }[]>`
      update conversations
         set spend_usd_micros = spend_usd_micros + ${args.micros.toString()},
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reserve: conversation ${args.conversationId} not found for this user`)
    }
    await tx`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, (now() at time zone 'utc')::date, ${args.micros.toString()})
      on conflict (user_id, day) do update
        set cost_micros = daily_usage.cost_micros + excluded.cost_micros,
            updated_at = now()`
    return { conversationMicros: BigInt(rows[0]!.spend_usd_micros) }
  }) as Promise<{ conversationMicros: bigint }>
}

/**
 * Applies the signed difference between what was reserved and what the call
 * actually cost. Normally a REFUND, because the reservation assumes a full
 * max_tokens of output that most responses never reach.
 *
 * Clamped at zero: `conversations.spend_usd_micros` carries a `>= 0` check
 * constraint, and a refund larger than the balance can only mean a bug
 * upstream. Aborting the turn on a constraint violation would turn an
 * accounting bug into a lost turn; clamping keeps the ceiling alive and leaves
 * the bug visible in the ledger, where model_calls records what was really spent.
 */
export async function reconcile(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; reserved: bigint; actual: bigint },
): Promise<{ conversationMicros: bigint }> {
  const delta = args.actual - args.reserved
  return sql.begin(async (tx) => {
    const rows = await tx<{ spend_usd_micros: string }[]>`
      update conversations
         set spend_usd_micros = greatest(0, spend_usd_micros + ${delta.toString()}),
             updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (rows.length === 0) {
      throw new Error(`reconcile: conversation ${args.conversationId} not found for this user`)
    }
    await tx`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, (now() at time zone 'utc')::date, 0)
      on conflict (user_id, day) do update
        set cost_micros = greatest(0, daily_usage.cost_micros + ${delta.toString()}),
            updated_at = now()`
    return { conversationMicros: BigInt(rows[0]!.spend_usd_micros) }
  }) as Promise<{ conversationMicros: bigint }>
}
