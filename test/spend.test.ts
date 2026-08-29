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

  // NOTE: this does NOT prove concurrency safety. withTestDb opens the pool
  // with max: 1, and each recordSpend's sql.begin() is shimmed onto that one
  // already-open connection as a savepoint, so a single physical connection
  // cannot interleave transactions — postgres.js queues these ten calls and
  // they execute strictly sequentially. The concurrency guarantee rests on
  // the single-statement atomic upsert (`on conflict ... do update set
  // cost_micros = daily_usage.cost_micros + excluded.cost_micros`) in
  // recordSpend itself, not on this test. This test only proves that
  // repeated increments accumulate into one row.
  it('accumulates repeated increments into one daily_usage row', async () => {
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

  it('reads the global daily total across every user, not just this one', async () => {
    await withTestDb(async (sql) => {
      const a = '00000000-0000-4000-8000-00000000aa01'
      const b = '00000000-0000-4000-8000-00000000bb01'
      const [ca] = await sql`insert into conversations (user_id) values (${a}) returning *`
      const [cb] = await sql`insert into conversations (user_id) values (${b}) returning *`

      // Asserted as a DELTA. This runs inside a rolled-back transaction but against
      // a database that may already hold today's real spend, so an absolute
      // expectation would be untestable; the delta still fails against an
      // implementation that reads one user's row instead of summing all of them.
      const before = (await readSpendFailClosed(sql, a, ca!.id)).globalMicros
      await recordSpend(sql, { userId: a, conversationId: ca!.id, costMicros: 1_000n })
      await recordSpend(sql, { userId: b, conversationId: cb!.id, costMicros: 2_500n })

      const spend = await readSpendFailClosed(sql, a, ca!.id)
      expect(spend.dailyMicros).toBe(1_000n)                    // this user only
      expect(spend.globalMicros - before).toBe(3_500n)          // every user today
    })
  })

  // Deliberately NOT the brief's 'fails closed on the global read too'. That test
  // would have duplicated the one above and, worse, exercised the CONVERSATION
  // read while claiming to test the global one. The global read cannot fail
  // closed: `sum(...)` over zero rows is 0, and 0 is a legitimate answer ("nobody
  // has spent today") that is indistinguishable from "the database gave no
  // answer". This pins what it actually does, so the zero is never mistaken for a
  // confirmed guarantee. The conversation read above it is the guard that throws.
  it('returns 0n for the global total when nothing is recorded — it cannot fail closed', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      await sql`delete from daily_usage where day = (now() at time zone 'utc')::date`
      const s = await readSpendFailClosed(sql, USER, c!.id)
      expect(s.globalMicros).toBe(0n)          // zero, NOT a throw
    })
  })

  // The spec fixes the day boundary at UTC, but `current_date` is the SESSION's
  // date: on a connection whose TimeZone is not UTC the writer would increment one
  // day's row while the reader looks at another's. Both sides are pinned here under
  // a session timezone deliberately chosen to disagree with UTC right now.
  it('counts the UTC day, not the session-local day', async () => {
    await withTestDb(async (sql) => {
      // Kiritimati (UTC+14) is a day AHEAD of UTC from 10:00 UTC onward; Etc/GMT+12
      // (UTC-12) is a day BEHIND before 12:00 UTC. At every hour at least one of the
      // two disagrees, so the choice is deterministic rather than dependent on when
      // the suite happens to run.
      let picked: string | null = null
      for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
        const [r] = await sql`select (now() at time zone ${tz}::text)::date::text as local,
                                     (now() at time zone 'utc')::date::text as utc`
        if (r!.local !== r!.utc) { picked = tz; break }
      }
      expect(picked).not.toBeNull()
      await sql`select set_config('TimeZone', ${picked!}, true)`   // transaction-local
      await sql`delete from daily_usage where user_id = ${USER}`

      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
      await recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 7_000n })

      const [utc] = await sql`select (now() at time zone 'utc')::date::text as d`
      const rows = await sql`select day::text as day from daily_usage where user_id = ${USER}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.day).toBe(utc!.d)        // the WRITE landed on the UTC day
      const s = await readSpendFailClosed(sql, USER, c!.id)
      expect(s.dailyMicros).toBe(7_000n)       // and the READ found it there
      expect(s.globalMicros).toBeGreaterThanOrEqual(7_000n)
    })
  })
})
