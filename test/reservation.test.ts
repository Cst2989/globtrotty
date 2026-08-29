// test/reservation.test.ts
import { describe, expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { estimateMicros, reserve, reconcile } from '../src/repo/reservation.js'
import { SEATS } from '../src/model/seats.js'

describe('estimateMicros', () => {
  it('prices input at list and assumes max_tokens of output — an upper bound', () => {
    // driver: opus-5 at 5 micros/input-token, 25/output-token, maxTokens 16000.
    // 1000 input => 5000, plus 16000 * 25 = 400000 => 405000.
    expect(estimateMicros(SEATS.driver, 1000)).toBe(405_000n)
  })

  it('is an UPPER bound: never below what the same call could actually cost', () => {
    const seat = SEATS.driver
    const est = estimateMicros(seat, 1000)
    // The worst real case is exactly max_tokens of output with no caching.
    const worst =
      BigInt(1000 * 5) + BigInt(seat.maxTokens * 25)
    expect(est).toBeGreaterThanOrEqual(worst)
  })

  it('prices a Haiku seat lower than an Opus seat for the same input', () => {
    expect(estimateMicros(SEATS.scout, 1000)).toBeLessThan(estimateMicros(SEATS.driver, 1000))
  })
})

describeDb('reserve / reconcile', () => {
  const seed = async (sql: any, n: string) => {
    const userId = `00000000-0000-4000-8000-0000000003${n}`
    const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
    return { userId, conversationId: c!.id as string }
  }

  it('returns the NEW total, not the total before the call', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '01')
      const first = await reserve(sql, { userId, conversationId, micros: 1_000n })
      expect(first.conversationMicros).toBe(1_000n)
      const second = await reserve(sql, { userId, conversationId, micros: 500n })
      // A stale read would return 1000 again — that is the v1 defect spec 8 names.
      expect(second.conversationMicros).toBe(1_500n)
    })
  })

  it('refunds the difference when the call cost less than reserved', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '02')
      await reserve(sql, { userId, conversationId, micros: 10_000n })
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 10_000n, actual: 2_500n,
      })
      expect(after.conversationMicros).toBe(2_500n)
    })
  })

  it('charges the difference when the call cost MORE than reserved', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '03')
      await reserve(sql, { userId, conversationId, micros: 1_000n })
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 1_000n, actual: 4_000n,
      })
      expect(after.conversationMicros).toBe(4_000n)
    })
  })

  it('never drives the counter below zero', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '04')
      await reserve(sql, { userId, conversationId, micros: 100n })
      // A refund larger than the balance can only mean a bug upstream, but the
      // column has a >= 0 check constraint: clamping keeps the guardrail alive
      // rather than aborting the turn on a constraint violation.
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 5_000n, actual: 0n,
      })
      expect(after.conversationMicros).toBe(0n)
    })
  })

  it('writes daily_usage on the reservation, on a UTC day boundary', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '05')
      await reserve(sql, { userId, conversationId, micros: 777n })
      const [row] = await sql`
        select cost_micros from daily_usage
         where user_id = ${userId} and day = (now() at time zone 'utc')::date`
      expect(BigInt(row!.cost_micros as string)).toBe(777n)
    })
  })
})
