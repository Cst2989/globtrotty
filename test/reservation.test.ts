import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { estimateBatchMicros, estimateMicros, reconcile, reserve } from '../src/repo/reservation.js'
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
    const expected = 1_000 * 5 * Math.max(p.cacheWrite1hMult, 1) + 16_000 * 25
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
    }, '1h')
    expect(actual).toBeLessThanOrEqual(reserved)
  })

  it('refuses to reserve zero for a model it cannot price', () => {
    expect(() => estimateMicros({ ...SEATS.driver, model: 'claude-imaginary' }, 10))
      .toThrow(/Refusing to reserve zero/)
  })

  it('rounds up rather than truncating', () => {
    // BigInt() throws a RangeError on a non-integer rather than truncating, so
    // an un-rounded value here would crash the pre-dispatch path outright rather
    // than misprice it.
    //
    // Priced against a model this case registers and removes again, because
    // from lesson 5.6 no model in the real table can produce a fractional bound
    // at all: `cacheWrite1hMult` is exactly 2, and an integer token count times
    // an integer micro rate times 2 is always whole. This case used to lean on
    // the 1.25 multiplier making 8.75 micros of input, and moving the bound to
    // the 1h rate quietly took its fraction away, which would have left
    // `Math.ceil` in `estimateMicros` guarded by nothing at all while still
    // being the line that keeps a future fractional price from throwing.
    //
    // Registered in the exported `PRICES` and removed again in the `finally`,
    // which is what keeps this case from being visible to any other. It has to
    // be removed rather than left: `test/pricing.test.ts` asserts
    // `Object.keys(PRICES)` equals exactly the two models we staff, so a leaked
    // third key is a failure in another file that names neither this case nor
    // this model. Vitest gives each test FILE its own module registry, so the
    // two cannot collide today, and the `finally` is what makes that a property
    // of this case rather than of the runner's isolation settings.
    const model = 'claude-fractional-for-this-case'
    PRICES[model] = {
      inMicrosPerToken: 1.25, outMicrosPerToken: 5,
      cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1,
    }
    try {
      const seat = { ...SEATS.cheap, model }
      const p = PRICES[model]!
      const exact = 7 * p.inMicrosPerToken * Math.max(p.cacheWrite1hMult, 1)
        + seat.maxTokens * p.outMicrosPerToken
      // 17.5 micros of input on top of a whole number of output micros, so there
      // really is something here to round; a case built on an already-integral
      // value would pass against truncation too.
      expect(Number.isInteger(exact)).toBe(false)
      expect(() => estimateMicros(seat, 7)).not.toThrow()
      // UP, to the next whole micro, and strictly above what truncating would
      // have produced. `% 1n` on a bigint is 0n for every possible
      // implementation, this one and a truncating one alike, so it pinned
      // nothing at all.
      expect(estimateMicros(seat, 7)).toBe(BigInt(Math.ceil(exact)))
      expect(estimateMicros(seat, 7)).toBeGreaterThan(BigInt(Math.trunc(exact)))
    } finally {
      delete PRICES[model]
    }
  })

  it('bounds a batch at n times the per-call bound', () => {
    expect(estimateBatchMicros(SEATS.scout, 4_000, 3))
      .toBe(estimateMicros(SEATS.scout, 4_000) * 3n)
  })

  it('refuses a batch of nothing rather than reserving zero', () => {
    // A caller that computed n from an empty list would otherwise debit nothing
    // and dispatch nothing, which is harmless, and would also debit nothing and
    // dispatch three, which is not, once a later caller computes n differently.
    expect(() => estimateBatchMicros(SEATS.scout, 4_000, 0)).toThrow(/at least 1/)
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
