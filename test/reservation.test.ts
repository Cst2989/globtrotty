// test/reservation.test.ts
import type postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { estimateMicros, reserve, reconcile } from '../src/repo/reservation.js'
import { SEATS } from '../src/model/seats.js'
import { PRICES, costMicros } from '../src/pricing.js'

describe('estimateMicros', () => {
  it(
    'prices input at the 1h cache-WRITE rate, not list — every driver call writes '
    + 'system+tools at that TTL, so that is the worst case, not list price',
    () => {
      // driver: opus-5 at 5 micros/input-token * 2 (cacheWrite1hMult) = 10/token,
      // 25/output-token, maxTokens 16000.
      // 1000 input => 10000, plus 16000 * 25 = 400000 => 410000.
      expect(estimateMicros(SEATS.driver, 1000)).toBe(410_000n)
    },
  )

  it(
    'bounds a cold-cache call: a usage fixture that is entirely '
    + 'cache_creation_input_tokens at 1h must not exceed the reservation for the '
    + 'same token count — this is the exact gap IMPORTANT finding 1 named',
    () => {
      const seat = SEATS.driver
      const inputTokens = 1000
      const reserved = estimateMicros(seat, inputTokens)
      // Every input token arrives as a cache WRITE (cold cache), and the model
      // uses its full max_tokens of output — the worst realistic case the
      // reservation is supposed to bound.
      const usage = {
        input_tokens: 0, cache_creation_input_tokens: inputTokens,
        cache_read_input_tokens: 0, output_tokens: seat.maxTokens,
      }
      const actual = costMicros(seat.model, usage, '1h')
      // Before this fix, estimateMicros priced the input term at plain list
      // (no multiplier), so `actual` exceeded `reserved` by exactly
      // `inputTokens * inMicrosPerToken * (cacheWrite1hMult - 1)` — reverting
      // the multiplier in src/repo/reservation.ts makes this assertion fail
      // again, which is the point: it is the same gap by construction.
      expect(actual).toBeLessThanOrEqual(reserved)
      expect(actual).toBe(reserved)   // exact here: this usage IS the assumed worst case
    },
  )

  it('rounds UP a fractional estimate — and BigInt() would throw, not truncate, if it didn\'t', () => {
    // PRICES is exported mutable and Seat is a plain object, so a fractional
    // rate can be registered here with no production change — the same trick
    // `costMicros`'s 18.75-micro fixture uses in test/spend.test.ts. Every rate
    // in the real PRICES table is a whole number, so no fixture built from
    // SEATS/PRICES as they ship could ever distinguish Math.ceil from
    // Math.floor here; this is the only way to falsify the rounding direction.
    PRICES['fixture-fractional'] = {
      inMicrosPerToken: 0.5, outMicrosPerToken: 1,
      cacheWrite5mMult: 1, cacheWrite1hMult: 1, cacheReadMult: 1,
    }
    try {
      const seat = { ...SEATS.titler, model: 'fixture-fractional', maxTokens: 1 }
      // 3 * 0.5 + 1 * 1 = 2.5 -> ceil is 3n. Math.floor would give 2n (this test
      // would then fail); no rounding at all would hand BigInt() a non-integer
      // and BigInt(2.5) THROWS a RangeError rather than truncating.
      expect(estimateMicros(seat, 3)).toBe(3n)
    } finally {
      delete PRICES['fixture-fractional']
    }
  })

  it('prices a Haiku seat lower than an Opus seat for the same input', () => {
    expect(estimateMicros(SEATS.scout, 1000)).toBeLessThan(estimateMicros(SEATS.driver, 1000))
  })
})

describeDb('reserve / reconcile', () => {
  const seed = async (sql: postgres.Sql, n: string) => {
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
      const first = await reserve(sql, { userId, conversationId, micros: 10_000n })
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 10_000n, actual: 2_500n, day: first.day,
      })
      expect(after.conversationMicros).toBe(2_500n)
      // The clamp/refund path is pinned directly on daily_usage too, not just
      // on the conversation total.
      expect(after.dailyMicros).toBe(2_500n)
      const [row] = await sql`
        select cost_micros from daily_usage where user_id = ${userId} and day = ${first.day}`
      expect(BigInt(row!.cost_micros as string)).toBe(2_500n)
    })
  })

  it('charges the difference when the call cost MORE than reserved', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '03')
      const first = await reserve(sql, { userId, conversationId, micros: 1_000n })
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 1_000n, actual: 4_000n, day: first.day,
      })
      expect(after.conversationMicros).toBe(4_000n)
      expect(after.dailyMicros).toBe(4_000n)
    })
  })

  it('never drives the counter below zero', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '04')
      const first = await reserve(sql, { userId, conversationId, micros: 100n })
      // A refund larger than the balance can only mean a bug upstream, but the
      // column has a >= 0 check constraint: clamping keeps the guardrail alive
      // rather than aborting the turn on a constraint violation.
      const after = await reconcile(sql, {
        userId, conversationId, reserved: 5_000n, actual: 0n, day: first.day,
      })
      expect(after.conversationMicros).toBe(0n)
      // daily_usage carries the identical >= 0 constraint and must clamp too.
      expect(after.dailyMicros).toBe(0n)
    })
  })

  it(
    'reconciles against the day reserve landed on, not "today" — the midnight-crossing case',
    async () => {
      await withTestDb(async (sql) => {
        const { userId, conversationId } = await seed(sql, '06')
        // Stand in for a reservation that landed on a UTC day now in the past
        // relative to "today" inside this transaction — exactly the shape of a
        // driver call (extended thinking included) that starts before UTC
        // midnight and is reconciled after it crosses. A `reconcile` that
        // recomputes "today" instead of taking the day `reserve` returned would:
        // drop this delta into a spurious zero row it inserts for today, and
        // leave the stale day's row untouched — silently undercounting it.
        const stale = '2020-01-01'
        await sql`
          insert into daily_usage (user_id, day, cost_micros) values (${userId}, ${stale}, 10000)`
        await sql`
          update conversations set spend_usd_micros = spend_usd_micros + 10000
           where id = ${conversationId}`

        const after = await reconcile(sql, {
          userId, conversationId, reserved: 10_000n, actual: 2_500n, day: stale,
        })
        expect(after.conversationMicros).toBe(2_500n)
        expect(after.dailyMicros).toBe(2_500n)

        const [staleRow] = await sql`
          select cost_micros from daily_usage where user_id = ${userId} and day = ${stale}`
        expect(BigInt(staleRow!.cost_micros as string)).toBe(2_500n)

        const todayRows = await sql`
          select 1 from daily_usage
           where user_id = ${userId} and day = (now() at time zone 'utc')::date`
        // Today must be untouched — no spurious row, no dropped delta landing
        // on the wrong day. This is exactly the bug the `day` argument removes.
        expect(todayRows).toHaveLength(0)
      })
    },
  )

  it('writes daily_usage on the reservation, on a UTC day boundary', async () => {
    await withTestDb(async (sql) => {
      // The spec fixes the day boundary at UTC, but `current_date` is the
      // SESSION's date: on a connection whose TimeZone is not UTC, a
      // `current_date` implementation would bucket the write on the wrong day
      // and this test would still pass if it only checked the UTC expression
      // (both would agree by coincidence). Force the session onto a timezone
      // that disagrees with UTC right now, same pattern as
      // test/spend.test.ts's UTC-day test.
      let picked: string | null = null
      let utcDay = ''
      for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
        const [r] = await sql`select (now() at time zone ${tz}::text)::date::text as local,
                                     (now() at time zone 'utc')::date::text as utc`
        if (r!.local !== r!.utc) { picked = tz; utcDay = r!.utc as string; break }
      }
      expect(picked).not.toBeNull()
      await sql`select set_config('TimeZone', ${picked!}, true)`   // transaction-local

      const { userId, conversationId } = await seed(sql, '05')
      const result = await reserve(sql, { userId, conversationId, micros: 777n })
      // The returned `day` is the UTC day, not the (disagreeing) session day.
      expect(result.day).toBe(utcDay)

      const [row] = await sql`
        select cost_micros from daily_usage
         where user_id = ${userId} and day = (now() at time zone 'utc')::date`
      expect(BigInt(row!.cost_micros as string)).toBe(777n)
    })
  })
})
