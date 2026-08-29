import type postgres from 'postgres'
import type { Spend } from '../engine.js'
import { pgSink, type ModelCallSink, type TurnContext } from './model-calls.js'

/**
 * THE DAY BOUNDARY IS UTC, everywhere in this file, and it must stay that way.
 *
 * `current_date` was the obvious spelling and is the wrong one: it is the
 * session's date, so it silently depends on the connection's TimeZone. This
 * project's vitest config pins a non-UTC zone on purpose, Netlify functions do
 * not guarantee UTC either, and a pooler can hand out a session configured by
 * someone else. Under any non-UTC session `current_date` rolls the daily bucket
 * over at the wrong hour, and a writer and a reader that disagree about "today"
 * mean the daily and global ceilings quietly stop counting the spend they exist
 * to count. `(now() at time zone 'utc')::date` is the same value on every
 * connection. It is repeated inline rather than composed, because a nested
 * fragment would have to be built from whichever handle the caller passed in;
 * the three copies below are the whole of it and one test asserts them together.
 */

/**
 * Records spend against a conversation and against the caller's daily total,
 * atomically, and returns the values after the increment. This is the only
 * writer of `course.conversations.spend_usd_micros` and
 * `course.daily_usage.cost_micros`.
 *
 * The daily upsert is a single insert-on-conflict-do-update, not a read then a
 * write, so ten concurrent increments cannot clobber each other.
 *
 * Called once per model call, not once at the end of a turn, so a ceiling check
 * reading these numbers sees one that is never stale for the rest of the turn.
 */
export async function recordSpend(
  sql: postgres.Sql,
  args: { userId: string; conversationId: string; costMicros: bigint },
): Promise<{ conversationMicros: bigint; dailyMicros: bigint }> {
  return await sql.begin(async (tx) => {
    const conv = await tx`
      update course.conversations set spend_usd_micros = spend_usd_micros + ${args.costMicros.toString()},
                                      updated_at = now()
       where id = ${args.conversationId} and user_id = ${args.userId}
      returning spend_usd_micros`
    if (conv.length === 0) throw new Error('recordSpend: conversation not found (fail closed)')

    const day = await tx`
      insert into course.daily_usage (user_id, day, cost_micros)
      values (${args.userId}, (now() at time zone 'utc')::date, ${args.costMicros.toString()})
      on conflict (user_id, day)
        do update set cost_micros = course.daily_usage.cost_micros + excluded.cost_micros,
                      updated_at = now()
      returning cost_micros`

    return {
      conversationMicros: BigInt(conv[0]!.spend_usd_micros as string),
      dailyMicros: BigInt(day[0]!.cost_micros as string),
    }
  })
}

/**
 * Reads current spend for the ceiling check. THROWS rather than returning zero
 * when it cannot confirm usage: a `?? 0` here means the guardrail disables
 * itself exactly when the database is unhealthy, which is the one failure this
 * function exists to prevent. A fresh user with no course.daily_usage row yet
 * is not a failure and legitimately reads as 0n.
 *
 * How far the guarantee reaches, stated plainly, because a guard everyone
 * believes in and nobody has checked is worse than no guard. The conversation
 * read is the one that fails closed: a conversation row that cannot be found is
 * unambiguously no answer, and it throws. The daily and global reads cannot make
 * the same promise, because a missing row and a sum over zero rows both
 * legitimately mean nothing was spent today and neither is distinguishable from
 * an answer the database failed to give. So their 0n is a real reading, not a
 * confirmed one, and neither may ever be the only guard on a request. An
 * unreachable database throws out of the first query anyway.
 */
export async function readSpendFailClosed(
  sql: postgres.Sql,
  userId: string,
  conversationId: string,
): Promise<Spend> {
  const conv = await sql`
    select spend_usd_micros from course.conversations
     where id = ${conversationId} and user_id = ${userId}`
  if (conv.length === 0) {
    throw new Error('Cannot confirm conversation spend, fail closed, denying the request')
  }
  const day = await sql`
    select cost_micros from course.daily_usage
     where user_id = ${userId} and day = (now() at time zone 'utc')::date`

  // Every user's spend today, which is what the global ceiling caps. Summed in
  // the database rather than in JS, and cast to text so a total past 2^53 still
  // arrives exactly: bigint columns are money here and must never round.
  const all = await sql`
    select coalesce(sum(cost_micros), 0)::text as total
      from course.daily_usage where day = (now() at time zone 'utc')::date`

  return {
    conversationMicros: BigInt(conv[0]!.spend_usd_micros as string),
    dailyMicros: day.length ? BigInt(day[0]!.cost_micros as string) : 0n,
    globalMicros: BigInt(all[0]!.total as string),
  }
}

/**
 * The sink every turn actually uses: the course.model_calls row is
 * observability, the spend increment is enforcement, and they are deliberately
 * not given the same error path. A failed row write is logged and swallowed,
 * because losing a record must not cost her the turn. A failed spend write is
 * not swallowed, because a ceiling that cannot record what was spent has
 * stopped being a ceiling.
 */
export function ledgerSink(sql: postgres.Sql, ctx: TurnContext): ModelCallSink {
  const writeCall = pgSink(sql, ctx)
  return async (facts) => {
    await writeCall(facts).catch((err) => {
      console.error('model_calls write failed', err)
    })
    if (ctx.conversationId) {
      await recordSpend(sql, {
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        costMicros: facts.costMicros,
      })
    }
  }
}
