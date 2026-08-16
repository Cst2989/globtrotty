import type postgres from 'postgres'

/**
 * Records spend against a conversation and against the caller's daily total,
 * atomically, and returns the post-increment values. This is the ONLY writer
 * of `conversations.spend_usd_micros` and `daily_usage.cost_micros` — Task 7's
 * `completeTurn` deliberately writes only `turns.spend_usd_micros` so this
 * function's job is never duplicated.
 *
 * The daily upsert is a single `insert ... on conflict ... do update set
 * cost_micros = daily_usage.cost_micros + excluded.cost_micros`, not a
 * read-then-write, so ten concurrent increments cannot clobber each other.
 *
 * Called once per model call (not once at turn end), so a per-call ceiling
 * check reading this return value sees a number that is never stale for the
 * rest of the turn.
 */
export async function recordSpend(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; costMicros: bigint },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  return await sql.begin(async (tx) => {
    const conv = await tx`
      update conversations set spend_usd_micros = spend_usd_micros + ${args.costMicros.toString()},
                               updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (conv.length === 0) throw new Error('recordSpend: conversation not found (fail closed)')

    const day = await tx`
      insert into daily_usage (user_id, day, cost_micros)
      values (${args.userId}, current_date, ${args.costMicros.toString()})
      on conflict (user_id, day)
        do update set cost_micros = daily_usage.cost_micros + excluded.cost_micros,
                      updated_at = now()
      returning cost_micros`

    return {
      conversationMicros: BigInt(conv[0]!.spend_usd_micros as string),
      dailyMicros: BigInt(day[0]!.cost_micros as string),
    }
  })
}

/**
 * Reads current spend for the per-call ceiling check. THROWS rather than
 * returning zero when it cannot confirm usage — a `count ?? 0` here would
 * mean the guardrail silently disables itself exactly when the database is
 * unhealthy, which is the one failure mode this function exists to prevent.
 * A fresh user with no `daily_usage` row yet is not a failure and legitimately
 * reads as 0n.
 */
export async function readSpendFailClosed(
  sql: postgres.Sql,
  userId: string,
  conversationId: string,
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  const conv = await sql`
    select spend_usd_micros from conversations
     where id = ${conversationId} and user_id = ${userId}`
  if (conv.length === 0) {
    throw new Error('Cannot confirm conversation spend — fail closed, denying the request')
  }
  const day = await sql`
    select cost_micros from daily_usage where user_id = ${userId} and day = current_date`
  return {
    conversationMicros: BigInt(conv[0]!.spend_usd_micros as string),
    dailyMicros: day.length ? BigInt(day[0]!.cost_micros as string) : 0n,
  }
}
