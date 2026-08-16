import { describe, it, expect } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { costMicros } from '../src/pricing.js'
import { recordSpend, readSpendFailClosed } from '../src/repo/spend.js'

const USER = '11111111-1111-1111-1111-111111111111'

describe('costMicros', () => {
  it('prices Opus 5 input and output', () => {
    // $5/MTok in, $25/MTok out => 5 and 25 micros per 1k tokens
    const c = costMicros('claude-opus-5', {
      input_tokens: 1_000_000, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 0,
    })
    expect(c).toBe(5_000_000n)          // $5.00
  })

  it('prices cache writes and reads DIFFERENTLY — one column could not', () => {
    const write = costMicros('claude-opus-5', {
      input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0, output_tokens: 0,
    })
    const read = costMicros('claude-opus-5', {
      input_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000, output_tokens: 0,
    })
    expect(write).toBe(6_250_000n)      // 1.25x
    expect(read).toBe(500_000n)         // 0.1x
    expect(Number(write) / Number(read)).toBe(12.5)
  })

  it('does not round a cheap Haiku call to zero', () => {
    const c = costMicros('claude-haiku-4-5-20251001', {
      input_tokens: 500, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 20,
    })
    expect(c).toBeGreaterThan(0n)       // in cents this would have been 0
  })

  it('throws on an unpriced model rather than charging zero', () => {
    expect(() => costMicros('some-future-model', {
      input_tokens: 1, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 1,
    })).toThrow()
  })
})

describeDb('recordSpend', () => {
  it('increments conversation and daily counters atomically and returns totals', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      const a = await recordSpend(sql, {
        userId: USER, conversationId: c!.id, costMicros: 1000n,
      })
      expect(a).toEqual({ conversationMicros: 1000n, dailyMicros: 1000n })
      const b = await recordSpend(sql, {
        userId: USER, conversationId: c!.id, costMicros: 500n,
      })
      expect(b).toEqual({ conversationMicros: 1500n, dailyMicros: 1500n })
    })
  })

  it('upserts daily usage rather than losing a concurrent increment', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      await Promise.all(
        Array.from({ length: 10 }, () =>
          recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 100n })),
      )
      const [row] = await sql`select cost_micros from daily_usage where user_id = ${USER}`
      expect(BigInt(row!.cost_micros)).toBe(1000n)
    })
  })
})

describeDb('readSpendFailClosed', () => {
  it('returns zeros for a fresh user', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      const s = await readSpendFailClosed(sql, USER, c!.id)
      expect(s.dailyMicros).toBe(0n)
    })
  })

  it('throws rather than returning zero when the query fails — the ?? 0 trap', async () => {
    await withTestDb(async (sql) => {
      await expect(
        readSpendFailClosed(sql, USER, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(/fail closed/i)
    })
  })
})
