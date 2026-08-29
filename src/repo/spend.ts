import type postgres from 'postgres'
import type { Spend } from '../engine.js'

/**
 * THE DAY BOUNDARY IS UTC — everywhere in this file, and it must stay that way.
 *
 * `current_date` was the obvious spelling and is the wrong one: it is the
 * SESSION's date, so it silently depends on the connection's `TimeZone`. This
 * project's own vitest config pins `TZ=America/Los_Angeles`, Netlify functions
 * do not guarantee UTC either, and a pooler can hand out a session configured by
 * someone else. Under any non-UTC session `current_date` rolls the daily bucket
 * over at the wrong hour — and worse, a writer and a reader that disagree about
 * "today" mean the daily and global ceilings quietly stop counting the spend
 * they exist to count. `(now() at time zone 'utc')::date` is the same value on
 * every connection. Repeated inline rather than composed as a fragment because a
 * postgres.js nested fragment would have to be built from whichever `sql` or
 * transaction handle the caller passed in; the three copies below are the whole
 * of it and are asserted together by `test/spend.test.ts`'s UTC-day test.
 */

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
      values (${args.userId}, (now() at time zone 'utc')::date, ${args.costMicros.toString()})
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
 *
 * HOW FAR THE FAIL-CLOSED GUARANTEE ACTUALLY REACHES — stated plainly, because
 * a guard everyone believes in and nobody has checked is worse than no guard.
 * The CONVERSATION read is the one that fails closed: a conversation row that
 * cannot be found is unambiguously "no answer", and it throws. The DAILY and
 * GLOBAL reads cannot make the same promise. A missing `daily_usage` row and a
 * `sum(...)` over zero rows both legitimately mean "nothing spent today", and
 * neither is distinguishable from an answer the database failed to give. So
 * their 0n is a real reading, not a confirmed one, and neither may ever be the
 * only guard on a request — the conversation read above them is what turns a
 * database that is merely unreachable into a denial (an unreachable database
 * throws out of the very first query anyway, before any of this returns).
 */
export async function readSpendFailClosed(
  sql: postgres.Sql,
  userId: string,
  conversationId: string,
): Promise<Spend> {
  const conv = await sql`
    select spend_usd_micros from conversations
     where id = ${conversationId} and user_id = ${userId}`
  if (conv.length === 0) {
    throw new Error('Cannot confirm conversation spend — fail closed, denying the request')
  }
  const day = await sql`
    select cost_micros from daily_usage
     where user_id = ${userId} and day = (now() at time zone 'utc')::date`

  // Every user's spend today, which is what the global ceiling caps. Summed in
  // the database rather than in JS, and cast to text so a total past 2^53 still
  // arrives exactly — `bigint` columns are money here and must never round.
  const all = await sql`
    select coalesce(sum(cost_micros), 0)::text as total
      from daily_usage where day = (now() at time zone 'utc')::date`

  return {
    conversationMicros: BigInt(conv[0]!.spend_usd_micros as string),
    dailyMicros: day.length ? BigInt(day[0]!.cost_micros as string) : 0n,
    globalMicros: BigInt(all[0]!.total as string),
  }
}
