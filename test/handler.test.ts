import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type postgres from 'postgres'
import type { Limits } from '../src/engine.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { describeDb, withTestDb } from './helpers/db.js'

// Fresh per run, the same reason withRealDb invents one (test/helpers/db.ts):
// a fixed id is also `scripts/trip.ts`'s demo user, so a reader's own live
// trip commits a real `daily_usage` row for it that outlives any one test's
// rolled-back transaction and is still there for the rest of the UTC day.
const USER = randomUUID()
const LIMITS = DEFAULT_LIMITS
// Two OTHER users, whose spend only the global ceiling can see. Fresh per run
// for the same reason USER is.
const OTHER_A = randomUUID()
const OTHER_B = randomUUID()
const deps = (
  sql: postgres.Sql, invoke = vi.fn().mockResolvedValue(undefined), limits: Limits = LIMITS,
) => ({ sql, limits, invoke })

/**
 * `LIMITS` with the global ceiling lifted just above what the account has
 * already spent today, for the two cases below that are about HER daily
 * ceiling and about the message she gets for it.
 *
 * `whichCeiling` (src/engine.ts) checks the GLOBAL ceiling first, and so does
 * `exceedsAnyCeiling` beside it, and that ceiling
 * is cross-user and per UTC day, so those cases' verdict was decided by rows
 * they do not own. `npm run evals` commits one `course.daily_usage` row per
 * case under a randomUUID user that nothing reads again, so a day with enough
 * eval runs in it puts the account within $15 of the $50 global ceiling, her
 * own ceiling row pushes it over, and a case asserting the DAILY message gets
 * the account one. The suite then goes red for a reason that has nothing to do
 * with the code under test.
 *
 * Read from today's ACTUAL total rather than set to a large constant, and read
 * inside the transaction so it accounts for her own row, which is the idiom the
 * global-ceiling case below already uses and for the reason written there:
 * deleting every row for today to force a clean slate would delete a row this
 * test does not own.
 */
async function dailyOnly(sql: postgres.Sql): Promise<Limits> {
  const [row] = await sql`select coalesce(sum(cost_micros), 0)::text as total
                            from course.daily_usage where day = (now() at time zone 'utc')::date`
  return { ...LIMITS, globalCeilingMicros: BigInt(row!.total as string) + 1n }
}

describeDb('submitMessage', () => {
  it('creates a conversation, a message, and a queued turn, then invokes', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const result = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: HER_MESSAGE, idempotencyKey: 'i1',
      })
      expect(result.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(result.turnId)
      const msgs = await sql`select role, content, turn_id from course.messages where conversation_id = ${result.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe(HER_MESSAGE)
      // Her message names the turn it was queued for, which is how the worker
      // finds it again in lesson 2.2.
      expect(msgs[0]!.turn_id).toBe(result.turnId)
      const [t] = await sql`select status from course.turns where id = ${result.turnId}`
      expect(t!.status).toBe('queued')
      // The conversation row records that a turn is in flight.
      const [c] = await sql`select status from course.conversations where id = ${result.conversationId}`
      expect(c!.status).toBe('working')
    })
  })

  // This used to exercise "the same conversation keeps taking messages."
  // `turns_one_active_per_conversation` now refuses the second submit while the
  // first turn is still `queued`, so from this lesson on this is a busy-path
  // test, not a second-turn test.
  it('keeps her second message on the same conversation, with the first turn still busy', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const first = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'one', idempotencyKey: 'i1',
      })
      const second = await submitMessage(d, {
        userId: USER, conversationId: first.conversationId, message: 'two', idempotencyKey: 'i2',
      })
      expect(second.conversationId).toBe(first.conversationId)
      expect(second.status).toBe('busy')
      expect(second.turnId).toBeNull()
      const msgs = await sql`select content from course.messages where conversation_id = ${first.conversationId} order by seq`
      expect(msgs.map((m) => m.content)).toEqual(['one', 'two'])
    })
  })

  it('returns the same turn for a duplicate idempotency key', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'same',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'hi', idempotencyKey: 'same',
      })
      expect(b.status).toBe('duplicate')
      expect(b.turnId).toBe(a.turnId)
      // And her sentence is in the thread once, not twice.
      const msgs = await sql`select id from course.messages where conversation_id = ${a.conversationId}`
      expect(msgs).toHaveLength(1)
    })
  })

  // The turn is durable before invoke runs. A failed invocation is not her
  // problem, but it is still ours, so it is logged rather than swallowed.
  it('still reports queued when the invocation fails, and says so on stderr', async () => {
    await withTestDb(async (sql) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const invoke = vi.fn().mockRejectedValue(new Error('502 from Netlify'))
        const result = await submitMessage(deps(sql, invoke), {
          userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
        })
        expect(result.status).toBe('queued')
        expect(result.turnId).not.toBeNull()
        const [t] = await sql`select status from course.turns where id = ${result.turnId}`
        expect(t!.status).toBe('queued')
        // The failure is reported, not discarded: an operator has to be able to
        // see that nothing picked this turn up.
        expect(logged).toHaveBeenCalledTimes(1)
        expect(String(logged.mock.calls[0]![0])).toContain(result.turnId)
      } finally {
        logged.mockRestore()
      }
    })
  })

  it('denies when the daily ceiling is reached, before spending anything', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  // The version of this handler that returned on the limit_reached path above
  // the message insert dropped a capped user's words on the floor. She now
  // also gets a real reply back, naming the limit she hit, rather than
  // silence after what she typed.
  it('still preserves her message when the ceiling is reached, and answers her', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const r = await submitMessage(deps(sql, undefined, await dailyOnly(sql)), {
        userId: USER, conversationId: null, message: 'a very expensive trip to Japan', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      const msgs = await sql`select role, content, turn_id from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('a very expensive trip to Japan')
      expect(msgs[0]!.turn_id).toBeNull()      // no turn was opened for it
      expect(msgs[1]!.role).toBe('agent')
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.daily)
    })
  })

  // writeHerMessage's on-conflict guard only proved a retry skips HER line;
  // nothing pinned that the reply beside it is skipped too. A retried capped
  // press must leave exactly one of each, not a second reply glued onto her
  // one kept sentence.
  it('leaves one message row and one reply row when a capped press is sent twice with the same key', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into course.daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const d = deps(sql, undefined, await dailyOnly(sql))
      const first = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'a very expensive trip to Japan', idempotencyKey: 'same-capped-press',
      })
      const second = await submitMessage(d, {
        userId: USER, conversationId: first.conversationId, message: 'a very expensive trip to Japan',
        idempotencyKey: 'same-capped-press',
      })
      expect(second.status).toBe('limit_reached')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${first.conversationId} order by seq`
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[1]!.role).toBe('agent')
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.daily)
    })
  })

  // The global ceiling protects the ACCOUNT, not the user: she has spent nothing
  // at all here, so neither per-user counter could possibly refuse her. Without
  // this check tier 2 would wave a capped account through and the refusal would
  // land one step into the turn instead, after a model call has been paid for.
  //
  // OTHER_A and OTHER_B's spend is computed as an offset from today's ACTUAL
  // global total, read first, rather than assuming the table starts empty:
  // `daily_usage` is shared, and deleting every row for today to force a
  // clean slate would delete a row this test does not own (a reader's own
  // live trip, or another test's fixed-day row).
  it('denies at tier 2 when the global ceiling is reached, though this user spent nothing', async (ctx) => {
    await withTestDb(async (sql) => {
      const totalRows = await sql`select coalesce(sum(cost_micros), 0)::text as total
                                    from course.daily_usage where day = (now() at time zone 'utc')::date`
      const remaining = LIMITS.globalCeilingMicros - BigInt(totalRows[0]!.total as string)
      // A live database's own daily_usage can already be at or over the global
      // ceiling for today, which would make `remaining` negative and the
      // insert below violate daily_usage_cost_micros_check instead of testing
      // anything: skip rather than fail on an account genuinely over ceiling.
      ctx.skip(remaining <= 0n, 'the account is genuinely over its global ceiling today')
      const half = (remaining / 2n).toString()
      const rest = (remaining - remaining / 2n).toString()
      await sql`insert into course.daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${half}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${rest})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(r.turnId).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
      const [conv] = await sql`select status from course.conversations where id = ${r.conversationId}`
      expect(conv!.status).toBe('limit_reached')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.content).toBe('two weeks in Peru')
      // The global ceiling, not the conversation or the daily one, is what
      // fired here, and the sentence names it as hers to be told about.
      expect(msgs[1]!.role).toBe('agent')
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.account)
    })
  })

  // readSpendFailClosed filters on (id, user_id) together, so a conversation
  // that exists but belongs to someone else is indistinguishable from one
  // that does not exist at all: both throw, before anything is written. This
  // is reachable with a perfectly healthy database, unlike the other
  // fail-closed path (an unreachable one), and it is the one denial that does
  // NOT keep her message, unlike the ceiling denials above.
  it('rejects a conversation she does not own before writing anything', async () => {
    await withTestDb(async (sql) => {
      const OTHER = '44444444-4444-4444-4444-444444444444'
      const [theirs] = await sql`insert into course.conversations (user_id) values (${OTHER}) returning id`
      await expect(
        submitMessage(deps(sql), { userId: USER, conversationId: theirs!.id, message: 'hi', idempotencyKey: 'i1' }),
      ).rejects.toThrow(/fail closed/i)
      const msgs = await sql`select * from course.messages where conversation_id = ${theirs!.id}`
      expect(msgs).toHaveLength(0)
    })
  })

  // Same offset-from-the-actual-total reasoning as the test above, one micro
  // short of the ceiling instead of exactly on it.
  it('still queues the turn one micro BELOW the global ceiling', async (ctx) => {
    await withTestDb(async (sql) => {
      const totalRows = await sql`select coalesce(sum(cost_micros), 0)::text as total
                                    from course.daily_usage where day = (now() at time zone 'utc')::date`
      const remaining = LIMITS.globalCeilingMicros - BigInt(totalRows[0]!.total as string) - 1n
      // Same reasoning as the test above: a real account already at or over
      // the global ceiling today makes `remaining` negative, which has
      // nothing to prove here and would otherwise fail on the check
      // constraint instead of the assertion this test is actually about.
      ctx.skip(remaining <= 0n, 'the account is genuinely over its global ceiling today')
      const a = (remaining / 2n).toString()
      const b = (remaining - remaining / 2n).toString()
      await sql`insert into course.daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${a}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${b})`
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
    })
  })
})
