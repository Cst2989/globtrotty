import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { estimateMicros, reconcile, reserve } from '../src/repo/reservation.js'
import { SEATS } from '../src/seats.js'
import { costMicros, PRICES } from '../src/pricing.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

async function conversation(sql: postgres.Sql): Promise<string> {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  return c!.id as string
}

describe('the bound, before any call is made', () => {
  it('bounds every input token at the most expensive rate in the table', () => {
    const p = PRICES[SEATS.driver.model]!
    // 1000 input tokens at 5 micros, times the highest multiplier any input
    // token can be billed at today, plus a full max_tokens of output at 25.
    const expected = 1_000 * 5 * Math.max(p.cacheWriteMult, 1) + 16_000 * 25
    expect(estimateMicros(SEATS.driver, 1_000)).toBe(BigInt(Math.ceil(expected)))
  })

  it('is larger than any real call of the same size can cost', () => {
    // The reciprocal of the bound: a usage that spends every input token at the
    // worst rate and every output token, priced by costMicros, must not exceed
    // what estimateMicros reserved for the same token count. Lesson 5.6 puts a
    // 1h TTL on the wire and this assertion is what goes red if the bound is
    // not moved with it.
    const inputTokens = 1_000
    const reserved = estimateMicros(SEATS.driver, inputTokens)
    const actual = costMicros(SEATS.driver.model, {
      input_tokens: 0, cache_creation_input_tokens: inputTokens,
      cache_read_input_tokens: 0, output_tokens: SEATS.driver.maxTokens,
    })
    expect(actual).toBeLessThanOrEqual(reserved)
  })

  it('refuses to reserve zero for a model it cannot price', () => {
    expect(() => estimateMicros({ ...SEATS.driver, model: 'claude-imaginary' }, 10))
      .toThrow(/Refusing to reserve zero/)
  })

  it('rounds up rather than truncating', () => {
    // BigInt() throws a RangeError on a non-integer rather than truncating, and
    // every multiplier in the table is already fractional, so an un-rounded
    // value here would crash the pre-dispatch path outright rather than
    // misprice it.
    expect(() => estimateMicros(SEATS.cheap, 7)).not.toThrow()
    expect(estimateMicros(SEATS.cheap, 7) % 1n).toBe(0n)
  })
})

describeDb('reserve and reconcile', () => {
  it('debits the conversation and the day, and returns what they now hold', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      const out = await reserve(sql, { userId: USER, conversationId, micros: 400_000n })
      expect(out.conversationMicros).toBe(400_000n)
      expect(out.dailyMicros).toBe(400_000n)
      // The UTC day, returned rather than assumed, because reconcile needs it.
      expect(out.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('refunds the difference when the call cost less than the bound', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      const { day } = await reserve(sql, { userId: USER, conversationId, micros: 400_000n })
      const after = await reconcile(sql, {
        userId: USER, conversationId, reserved: 400_000n, actual: 30_420n, day,
      })
      expect(after.conversationMicros).toBe(30_420n)
      expect(after.dailyMicros).toBe(30_420n)
    })
  })

  it('charges the difference when the call cost more', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      const { day } = await reserve(sql, { userId: USER, conversationId, micros: 100n })
      const after = await reconcile(sql, {
        userId: USER, conversationId, reserved: 100n, actual: 900n, day,
      })
      expect(after.conversationMicros).toBe(900n)
    })
  })

  it('reconciles against the day the reservation landed on, not against today', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      const { day } = await reserve(sql, { userId: USER, conversationId, micros: 400_000n })
      // A driver call, extended thinking included, can be in flight across UTC
      // midnight. Recomputing "today" here would subtract the refund from a
      // different day's total than the one it was reserved against, and the two
      // counters would diverge permanently in the undercounting direction.
      const yesterday = '2026-08-28'
      expect(day).not.toBe(yesterday)
      await reconcile(sql, { userId: USER, conversationId, reserved: 400_000n, actual: 0n, day })
      const rows = await sql<{ day: string; cost_micros: string }[]>`
        select day::text as day, cost_micros from course.daily_usage
         where user_id = ${USER} order by day`
      expect(rows).toHaveLength(1)
      expect(BigInt(rows[0]!.cost_micros)).toBe(0n)
    })
  })

  it('clamps at zero in SQL rather than reading, clamping and writing back', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      const { day } = await reserve(sql, { userId: USER, conversationId, micros: 100n })
      // A refund larger than the balance can only mean a bug upstream. Aborting
      // the turn on a check-constraint violation would turn an accounting bug
      // into a lost turn; clamping keeps the ceiling alive and leaves the bug
      // visible in course.model_calls, which records what was really spent.
      const after = await reconcile(sql, {
        userId: USER, conversationId, reserved: 5_000n, actual: 0n, day,
      })
      expect(after.conversationMicros).toBe(0n)
    })
  })

  it('refuses a conversation that is not this user\'s', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await conversation(sql)
      await expect(reserve(sql, { userId: randomUUID(), conversationId, micros: 1n }))
        .rejects.toThrow(/not found for this user/)
    })
  })
})
