import { randomUUID } from 'node:crypto'
import { describeDb, withTestDb } from './helpers/db.js'
import { fencedModelCallSink, ledgerSink, readSpendFailClosed, recordSpend } from '../src/repo/spend.js'

// Fresh per run, the same reason withRealDb invents one (test/helpers/db.ts):
// a fixed id is also `scripts/trip.ts`'s demo user, so a reader's own live
// trip commits a real `daily_usage` row for it that outlives any one test's
// rolled-back transaction and is still there for the rest of the UTC day,
// which broke every absolute assertion below against a fixed id.
const USER = randomUUID()

describeDb('recordSpend', () => {
  it('increments conversation and daily counters atomically and returns totals', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      const a = await recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 1000n })
      expect(a).toEqual({ conversationMicros: 1000n, dailyMicros: 1000n })
      const b = await recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 500n })
      expect(b).toEqual({ conversationMicros: 1500n, dailyMicros: 1500n })
    })
  })

  // NOTE: this does NOT prove concurrency safety. withTestDb opens the pool with
  // max: 1, and each recordSpend's sql.begin() is shimmed onto that one
  // already-open connection as a savepoint, so a single physical connection
  // cannot interleave transactions: postgres.js queues these ten calls and they
  // execute strictly sequentially. The concurrency guarantee rests on the
  // single-statement atomic upsert in recordSpend itself, not on this test. This
  // test only proves that repeated increments accumulate into one row.
  it('accumulates repeated increments into one daily_usage row', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      await Promise.all(
        Array.from({ length: 10 }, () =>
          recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 100n })),
      )
      const [row] = await sql`select cost_micros from course.daily_usage where user_id = ${USER}`
      expect(BigInt(row!.cost_micros)).toBe(1000n)
    })
  })
})

describeDb('readSpendFailClosed', () => {
  it('returns zeros for a fresh user', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      const s = await readSpendFailClosed(sql, USER, c!.id)
      expect(s.dailyMicros).toBe(0n)
      expect(s.conversationMicros).toBe(0n)
      // The global read sums every user, not just this fresh one, so it
      // cannot be asserted as zero against a shared database that may
      // already hold today's real spend; it can still be pinned as "resolved
      // to a real bigint, not thrown", which is the guarantee this fresh
      // user's read actually needs from it.
      expect(typeof s.globalMicros).toBe('bigint')
      expect(s.globalMicros).toBeGreaterThanOrEqual(0n)
    })
  })

  it('throws rather than returning zero when the query finds nothing, which is the ?? 0 trap', async () => {
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
      const [ca] = await sql`insert into course.conversations (user_id) values (${a}) returning *`
      const [cb] = await sql`insert into course.conversations (user_id) values (${b}) returning *`

      // Asserted as a DELTA. This runs inside a rolled-back transaction but
      // against a database that may already hold today's real spend, so an
      // absolute expectation would be untestable; the delta still fails against
      // an implementation that reads one user's row instead of summing all.
      const before = (await readSpendFailClosed(sql, a, ca!.id)).globalMicros
      await recordSpend(sql, { userId: a, conversationId: ca!.id, costMicros: 1_000n })
      await recordSpend(sql, { userId: b, conversationId: cb!.id, costMicros: 2_500n })

      const spend = await readSpendFailClosed(sql, a, ca!.id)
      expect(spend.dailyMicros).toBe(1_000n)              // this user only
      expect(spend.globalMicros - before).toBe(3_500n)    // every user today
    })
  })

  // Deliberately NOT 'fails closed on the global read too'. That test would have
  // duplicated the one above and, worse, exercised the CONVERSATION read while
  // claiming to test the global one. The global read cannot fail closed: sum(...)
  // over zero MATCHING rows is 0, and 0 is a legitimate answer ("nobody has spent
  // that day") that is indistinguishable from "the database gave no answer".
  //
  // This pins the SQL behaviour directly, against a day nobody will ever write
  // real data to, rather than against today: `daily_usage` is shared, and
  // today may already hold a reader's own live spend, which deleting to force
  // a clean slate would destroy. `readSpendFailClosed`'s global query is
  // always `coalesce(sum(cost_micros), 0)` over `day = today`; this is the
  // same expression with the day swapped for one that is provably empty, so
  // it proves the same coalesce-catches-NULL fact without touching a row
  // this test does not own.
  it('reads 0, not a throw, for a day with zero matching rows', async () => {
    await withTestDb(async (sql) => {
      const [row] = await sql`select coalesce(sum(cost_micros), 0)::text as total
                                from course.daily_usage where day = '2099-12-31'`
      expect(row!.total).toBe('0')
    })
  })

  /**
   * The day boundary is UTC, but `current_date` is the SESSION's date: on a
   * connection whose TimeZone is not UTC the writer would increment one day's row
   * while the reader looks at another's. This is the test that actually pins it,
   * because it sets a non-UTC zone on the Postgres session itself, transaction
   * locally, which is the only place the setting matters. The vitest TZ pin does
   * not reach here; it configures Node.
   */
  it('counts the UTC day, not the session-local day', async () => {
    await withTestDb(async (sql) => {
      // Kiritimati (UTC+14) is a day AHEAD of UTC from 10:00 UTC onward;
      // Etc/GMT+12 (UTC-12) is a day BEHIND before 12:00 UTC. At every hour at
      // least one of the two disagrees, so the choice is deterministic rather
      // than dependent on when the suite happens to run.
      let picked: string | null = null
      for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
        const [r] = await sql`select (now() at time zone ${tz}::text)::date::text as local,
                                     (now() at time zone 'utc')::date::text as utc`
        if (r!.local !== r!.utc) { picked = tz; break }
      }
      expect(picked).not.toBeNull()
      await sql`select set_config('TimeZone', ${picked!}, true)`   // transaction-local
      await sql`delete from course.daily_usage where user_id = ${USER}`

      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      await recordSpend(sql, { userId: USER, conversationId: c!.id, costMicros: 7_000n })

      const [utc] = await sql`select (now() at time zone 'utc')::date::text as d`
      const rows = await sql`select day::text as day from course.daily_usage where user_id = ${USER}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.day).toBe(utc!.d)        // the WRITE landed on the UTC day
      const s = await readSpendFailClosed(sql, USER, c!.id)
      expect(s.dailyMicros).toBe(7_000n)       // and the READ found it there
      expect(s.globalMicros).toBeGreaterThanOrEqual(7_000n)
    })
  })
})

describeDb('ledgerSink', () => {
  it('records the call and the spend together', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      const sink = ledgerSink(sql, { userId: USER, conversationId: c!.id, turnId: null })
      await sink({
        seat: 'driver', promptVersion: 'p1',
        modelRequested: 'claude-opus-5', modelReturned: 'claude-opus-5',
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        costMicros: 750n, latencyMs: 12,
      })
      const rows = await sql`select cost_micros from course.model_calls where conversation_id = ${c!.id}`
      expect(rows).toHaveLength(1)
      // The claim this sink makes is that the observability row and the
      // enforcement counter carry the SAME number, both taken from
      // facts.costMicros. Asserting only the row's presence would pass even
      // if the two had diverged.
      expect(BigInt(rows[0]!.cost_micros)).toBe(750n)
      const [conv] = await sql`select spend_usd_micros from course.conversations where id = ${c!.id}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(750n)
    })
  })
})

// R2 from Task 6's fix-round-1 re-review: a fenced worker's model call, once
// made, already cost real money at the provider, whether or not the worker
// learns about the fence before or after that call settles. Dropping the row
// would make a real charge invisible to course.model_calls and to the
// ceiling it feeds, which src/repo/model-calls.ts's own pgSink refuses to do
// for its own write failures; fencedModelCallSink must not do it either.
describeDb('fencedModelCallSink', () => {
  const facts = {
    seat: 'driver' as const, promptVersion: 'p1',
    modelRequested: 'claude-opus-5', modelReturned: 'claude-opus-5',
    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costMicros: 750n, latencyMs: 12,
  }

  it('records a call that already happened even when the signal is already aborted', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      const controller = new AbortController()
      controller.abort(new Error('fenced'))
      const sink = fencedModelCallSink(
        ledgerSink(sql, { userId: USER, conversationId: c!.id, turnId: null }),
        controller.signal,
      )
      // The call the provider already answered is recorded even though the
      // fence was discovered before this sink ever ran: nothing about a
      // fence, past or future, is a reason to lose a row for money already
      // spent.
      await expect(sink(facts)).rejects.toThrow('fenced')
      const rows = await sql`select cost_micros from course.model_calls where conversation_id = ${c!.id}`
      expect(rows).toHaveLength(1)
      expect(BigInt(rows[0]!.cost_micros)).toBe(750n)
      const [conv] = await sql`select spend_usd_micros from course.conversations where id = ${c!.id}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(750n)
    })
  })

  it('refuses only the call AFTER the one that was already made', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning *`
      const controller = new AbortController()
      const sink = fencedModelCallSink(
        ledgerSink(sql, { userId: USER, conversationId: c!.id, turnId: null }),
        controller.signal,
      )
      await sink(facts)                                  // not yet fenced: records and returns
      controller.abort(new Error('fenced mid-turn'))
      await expect(sink({ ...facts, costMicros: 999n })).rejects.toThrow('fenced mid-turn')
      // By seq, never created_at: both rows carry the same
      // transaction_timestamp() inside withTestDb, so ordering by the clock
      // leaves the order to the planner (0002's own comment says so).
      const rows = await sql`select cost_micros from course.model_calls where conversation_id = ${c!.id} order by seq`
      // Each call to this sink represents one call that already happened at
      // the provider (that is `callAndRecord`'s own contract, src/metered.ts),
      // so both are recorded here; the fence's job is to stop a THIRD call
      // from ever being attempted, which is the caller's (toolLoop's) own
      // responsibility once this throws.
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => BigInt(r.cost_micros))).toEqual([750n, 999n])
    })
  })
})
