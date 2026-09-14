import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { withUser } from '../src/db.js'
import { readSpendFailClosed } from '../src/repo/spend.js'
import { describeDb, withRealDb } from './helpers/db.js'

/** Rows for a second traveller, cleaned up by hand: withRealDb only knows one id. */
async function seedOther(sql: postgres.Sql, his: string): Promise<string> {
  const [c] = await sql`insert into course.conversations (user_id) values (${his}) returning id`
  await sql`
    insert into course.daily_usage (user_id, day, cost_micros)
    values (${his}, (now() at time zone 'utc')::date, 7000)`
  return c!.id as string
}
async function dropOther(sql: postgres.Sql, his: string): Promise<void> {
  await sql`delete from course.daily_usage where user_id = ${his}`
  await sql`delete from course.conversations where user_id = ${his}`
}

describeDb('two travellers, one worker', () => {
  it('shows her nothing of his, through the real worker path', async () => {
    await withRealDb(async (sql, hers) => {
      const his = randomUUID()
      try {
        const [c] = await sql`
          insert into course.conversations (user_id) values (${hers}) returning id`
        const herConversation = c!.id as string
        const hisConversation = await seedOther(sql, his)
        // Read as the worker, with her id set, through the same helper
        // src/worker.ts uses. His conversation exists and is not returned.
        const rows = await withUser(sql, hers, (tx) =>
          tx<{ id: string }[]>`select id from course.conversations`)
        expect(rows.map((r) => r.id)).toEqual([herConversation])
        expect(rows.map((r) => r.id)).not.toContain(hisConversation)
      } finally {
        await dropOther(sql, his)
      }
    })
  })

  it('fails when the owner filter is removed, which is how we know it discriminates', async () => {
    // The whole point. A test that passed with the policy in place and also
    // passed without it would be testing the `where user_id =` clause the query
    // already had. This one runs a query with NO clause at all, twice: once as
    // the owner, where it returns both, and once as the worker, where it
    // returns one. The pair is the proof; either half alone proves nothing.
    await withRealDb(async (sql, hers) => {
      const his = randomUUID()
      try {
        await sql`insert into course.conversations (user_id) values (${hers})`
        await seedOther(sql, his)
        const asOwner = await sql<{ user_id: string }[]>`select user_id from course.conversations`
        const owners = new Set(asOwner.map((r) => r.user_id))
        expect(owners.has(hers)).toBe(true)
        expect(owners.has(his)).toBe(true)
        const asWorker = await withUser(sql, hers, (tx) =>
          tx<{ user_id: string }[]>`select user_id from course.conversations`)
        expect(new Set(asWorker.map((r) => r.user_id))).toEqual(new Set([hers]))
      } finally {
        await dropOther(sql, his)
      }
    })
  })

  it('refuses to file a row under somebody else\'s id', async () => {
    // The `with check` half. Without it an insert naming another user would be
    // written and then be invisible to everybody, including to the person who
    // wrote it, which is a worse outcome than a refusal.
    await withRealDb(async (sql, hers) => {
      const his = randomUUID()
      await expect(withUser(sql, hers, (tx) =>
        tx`insert into course.conversations (user_id) values (${his})`))
        .rejects.toThrow(/row-level security/i)
    })
  })

  it('returns nothing at all when no user id was set', async () => {
    // current_setting(..., true) returns null and `user_id::text = null` is
    // null, which is not true, so the row is not returned. Fail closed: a
    // connection that forgot to say who it is reads nothing rather than
    // everything.
    await withRealDb(async (sql, hers) => {
      await sql`insert into course.conversations (user_id) values (${hers})`
      const rows = await sql.begin(async (tx) => {
        await tx`set local role course_worker`
        // No set_config. This is the query a caller that forgot withUser runs.
        return tx`select id from course.conversations`
      })
      expect(rows).toHaveLength(0)
    })
  })

  it('still sums the global ceiling across every user', async () => {
    // The counter-argument to this whole lesson, asserted rather than argued.
    // course.daily_usage carries no policy, so readSpendFailClosed's cross-user
    // sum is still cross-user. If this ever returns only one user's spend, the
    // global ceiling has stopped firing and nothing else will say so.
    await withRealDb(async (sql, hers) => {
      const his = randomUUID()
      try {
        const [c] = await sql`
          insert into course.conversations (user_id) values (${hers}) returning id`
        await sql`
          insert into course.daily_usage (user_id, day, cost_micros)
          values (${hers}, (now() at time zone 'utc')::date, 3000)`
        await seedOther(sql, his)
        const before = await sql<{ total: string }[]>`
          select coalesce(sum(cost_micros), 0)::text as total from course.daily_usage
           where day = (now() at time zone 'utc')::date`
        const spend = await readSpendFailClosed(sql, hers, c!.id as string)
        // Everybody's spend today, hers and his and every other row on the
        // database, which is what a GLOBAL ceiling means.
        expect(spend.globalMicros).toBe(BigInt(before[0]!.total))
        expect(spend.globalMicros).toBeGreaterThanOrEqual(3_000n + 7_000n)
        // And her own daily figure is still only hers, so the two ceilings have
        // not collapsed into one number.
        expect(spend.dailyMicros).toBe(3_000n)
      } finally {
        await dropOther(sql, his)
      }
    })
  })

  it.each(['model_calls', 'daily_usage', 'tool_calls', 'gate_results'])(
    'gives the worker no reach into course.%s at all', async (table) => {
      // The four tables 0017 grants nothing on, one case each, because "not
      // under a policy" and "not reachable" are different facts and only the
      // second one is safety. A blanket `grant ... on all tables in schema
      // course` would leave every one of these readable in full by every
      // course_worker session, and the migration's own closing comment would
      // then describe the opposite of what it did. This is the assertion that
      // discriminates: it fails the moment the grant widens, and it is written
      // per table rather than as one loop body so a failure names which one.
      await withRealDb(async (sql, hers) => {
        await expect(withUser(sql, hers, (tx) => tx.unsafe(`select 1 from course.${table} limit 1`)))
          .rejects.toThrow(/permission denied/i)
      })
    })

  it('still lets the owner read all four, which is where the ledger runs', async () => {
    // The other half, and without it the pair above proves only that a table
    // name was misspelled. The sinks and the ceiling read are on the owner
    // connection by design (src/db.ts), so they must still work.
    await withRealDb(async (sql) => {
      for (const table of ['model_calls', 'daily_usage', 'tool_calls', 'gate_results']) {
        await expect(sql.unsafe(`select 1 from course.${table} limit 1`)).resolves.toBeDefined()
      }
    })
  })

  it('cannot reach course.conversions at all', async () => {
    // A fifth ungranted table, and one case rather than a fifth slot in the
    // `it.each` above: 0020's own closing comment promises exactly one case
    // here, which is what makes that paragraph checkable rather than merely
    // stated. No worker path reads or writes this table; a conversion arrives
    // on a reported feed, outside any turn, through the owner connection.
    await withRealDb(async (sql, hers) => {
      await expect(withUser(sql, hers, (tx) => tx`select 1 from course.conversions limit 1`))
        .rejects.toThrow(/permission denied/i)
    })
  })

  it('lets the worker read source facts, which belong to nobody', async () => {
    // The one table that IS granted and carries no policy, and the reason is the
    // table's own: it carries no user column, so there is no traveller in it to
    // isolate and a policy would hide every fact from everybody. Two verbs, not
    // four: nothing in this branch revises or retracts a source fact.
    await withRealDb(async (sql, hers) => {
      await expect(withUser(sql, hers, (tx) =>
        tx`select 1 from course.source_memory limit 1`)).resolves.toBeDefined()
      await expect(withUser(sql, hers, (tx) =>
        tx`delete from course.source_memory where source_key = 'nothing'`))
        .rejects.toThrow(/permission denied/i)
    })
  })

  it('releases the role and the setting when the transaction ends', async () => {
    // `set local`, not `set`. A pooled connection that kept the role would hand
    // the next caller somebody else's identity, which is a worse bug than the
    // one this lesson is fixing. Asserted on the connection AFTER the
    // transaction closed, which is the only place the difference shows.
    await withRealDb(async (sql, hers) => {
      await withUser(sql, hers, (tx) => tx`select 1`)
      const [row] = await sql<{ who: string; uid: string | null }[]>`
        select current_user as who, current_setting('course.user_id', true) as uid`
      expect(row!.who).not.toBe('course_worker')
      // Not null, and the difference is worth knowing rather than asserting
      // around: once a custom setting has been set on a session at all,
      // Postgres resets it to the EMPTY STRING rather than to null, so a
      // released `set_config(..., true)` reads as '' here and reads as null
      // only on a connection that was never handed one. Both are fail closed,
      // which is the property that matters: the policy compares
      // `user_id::text` against this value, and no uuid is '' or null.
      expect(row!.uid ?? '').toBe('')
      expect(row!.uid).not.toBe(hers)
    })
  })
})
