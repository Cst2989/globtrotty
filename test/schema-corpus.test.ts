import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { NOT_EVALUATED } from '../src/gates/pipeline.js'
import { recordGateResults } from '../src/repo/gateResults.js'

describeDb('0004 corpus schema', () => {
  it('stores a tool result and reads it back by (conversation_id, source_id)', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000001'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'KIWI-1', 'kiwi', 'flight', 'BER-FAO',
                ${(45400n).toString()}, 'EUR', 'total', 900, ${sql.json({ a: 1 })})`
      const [row] = await sql`
        select price_minor, currency, price_basis, fetched_at
          from tool_results where conversation_id = ${c!.id} and source_id = 'KIWI-1'`
      expect(BigInt(row!.price_minor as string)).toBe(45400n)
      expect(row!.currency).toBe('EUR')
      expect(row!.price_basis).toBe('total')
      expect(row!.fetched_at).toBeInstanceOf(Date)
    })
  })

  // CORRECTION (task-1 dispatch): this test used to be named "rejects a
  // duplicate (conversation_id, source_id)" and asserted that a second insert
  // for the same pair threw a unique-violation. That was asserting backlog
  // 2.1's bug: migration 0004's `unique (conversation_id, source_id)` is what
  // forced `recordResults` into an upsert, and every re-quote silently
  // destroyed the previous price for that id. Migration 0011 (spec §6:
  // `tool_results` is "untrimmed, append-only") drops that constraint, so a
  // duplicate `(conversation_id, source_id)` is no longer an error — it is
  // exactly what a second fetch of the same id is supposed to produce.
  it('allows a duplicate (conversation_id, source_id) — append-only per migration 0011', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000002'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      const ins = () => sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'DUP', 'mock', 'hotel', 'H',
                ${(100n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      await ins()
      await expect(ins()).resolves.toBeDefined()

      const rows = await sql<{ n: number }[]>`
        select count(*)::int as n from tool_results
         where conversation_id = ${c!.id} and source_id = 'DUP'`
      expect(rows[0]!.n).toBe(2)
    })
  })

  it('rejects a negative price and an unknown price_basis', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000003'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      // Each rejected insert gets its OWN savepoint. The plan ran both inside the
      // one transaction, so the first violation aborted it and the second assertion
      // saw "current transaction is aborted" instead of a check-constraint error —
      // the price_basis constraint was never actually exercised.
      const rejects = (basis: string, price: bigint) =>
        sql.begin((tx) => tx`
          insert into tool_results
            (conversation_id, user_id, source_id, supplier, kind, name,
             price_minor, currency, price_basis, ttl_seconds, payload)
          values (${c!.id}, ${userId}, ${'S-' + basis + price}, 'mock', 'hotel', 'H',
                  ${price.toString()}, 'EUR', ${basis}, 900, ${sql.json({})})`)

      await expect(rejects('total', -1n)).rejects.toThrow(/check constraint/i)
      await expect(rejects('wholesale', 1n)).rejects.toThrow(/check constraint/i)
      // ttl_seconds must be strictly positive, not merely non-negative.
      await expect(
        sql.begin((tx) => tx`
          insert into tool_results
            (conversation_id, user_id, source_id, supplier, kind, name,
             price_minor, currency, price_basis, ttl_seconds, payload)
          values (${c!.id}, ${userId}, 'TTL0', 'mock', 'hotel', 'H',
                  ${(1n).toString()}, 'EUR', 'total', 0, ${sql.json({})})`),
      ).rejects.toThrow(/check constraint/i)
      // The savepoints rolled back cleanly, so the outer transaction is still usable.
      const [ok] = await sql`select 1 as ok`
      expect(ok!.ok).toBe(1)
    })
  })

  it('cascades tool_results and proposals when the conversation is deleted', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000004'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await sql`
        insert into tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${userId}, 'X', 'mock', 'hotel', 'H',
                ${(1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      // The plan's version of this test never inserted a proposal, so it asserted
      // nothing about the table named in its own title — it would have passed
      // against a `proposals` with no foreign key at all.
      const [p] = await sql`
        insert into proposals
          (conversation_id, user_id, itinerary, requirements_snapshot,
           total_minor, currency, gate_outcome)
        values (${c!.id}, ${userId}, ${sql.json({ items: [] })}, ${sql.json({})},
                ${(1n).toString()}, 'EUR', 'approved')
        returning id`
      // A gate_results row hangs off the proposal, so this also pins the second
      // cascade hop: conversation -> proposal -> gate_results.
      await sql`
        insert into gate_results (proposal_id, conversation_id, gate, passed)
        values (${p!.id}, ${c!.id}, 'provenance', true)`

      await sql`delete from conversations where id = ${c!.id}`

      const tr = await sql`select 1 from tool_results where conversation_id = ${c!.id}`
      const pr = await sql`select 1 from proposals      where conversation_id = ${c!.id}`
      const gr = await sql`select 1 from gate_results   where proposal_id     = ${p!.id}`
      expect(tr.length).toBe(0)
      expect(pr.length).toBe(0)
      expect(gr.length).toBe(0)
    })
  })
})

describeDb('0005 gate_results integrity', () => {
  it('cascades an orphan gate_results row (proposal_id null) when the conversation is deleted', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000005'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      // This is exactly what Task 11 writes: gates run before a proposal row
      // exists, so proposal_id is null and conversation_id is the only path back
      // to the conversation. Against 0004 alone, conversation_id has no FK, so
      // this row survives the delete below and the assertion fails.
      await sql`
        insert into gate_results (proposal_id, conversation_id, gate, passed)
        values (null, ${c!.id}, 'provenance', true)`

      await sql`delete from conversations where id = ${c!.id}`

      const gr = await sql`select 1 from gate_results where conversation_id = ${c!.id}`
      expect(gr.length).toBe(0)
    })
  })

  it("accepts the 'slots' gate name", async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000006'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      await sql`
        insert into gate_results (proposal_id, conversation_id, gate, passed)
        values (null, ${c!.id}, 'slots', false)`
      const [row] = await sql`
        select gate from gate_results where conversation_id = ${c!.id} and gate = 'slots'`
      expect(row!.gate).toBe('slots')
    })
  })

  it('rejects an unknown gate name', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000007'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      // Own savepoint: a failing insert aborts the enclosing transaction, and a
      // later statement in that same transaction would see "current transaction
      // is aborted" instead of the real check-constraint error.
      await expect(
        sql.begin((tx) => tx`
          insert into gate_results (proposal_id, conversation_id, gate, passed)
          values (null, ${c!.id}, 'vibes', true)`),
      ).rejects.toThrow(/check constraint/i)
      // The savepoint rolled back cleanly, so the outer transaction is still usable.
      const [ok] = await sql`select 1 as ok`
      expect(ok!.ok).toBe(1)
    })
  })

  it('indexes gate_results on conversation_id', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql`
        select indexdef from pg_indexes
         where tablename = 'gate_results' and indexdef ilike '%conversation_id%'`
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  // Retitled. The old title was 'accepts passed = null, meaning "not evaluated
  // because a prerequisite gate failed"' -- the exact phrase migration 0006
  // exists to REMOVE, and which the sibling test below asserts is absent from
  // the live column comment. A test title is documentation too, and this one
  // was documenting the wording it is part of a pair to eliminate. The column
  // is nullable so the pipeline can record "the gate ran but could not reach a
  // verdict"; a gate SKIPPED by an earlier failure writes no row at all.
  it('accepts passed = null, for a gate that ran but could not reach a verdict', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000000008'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      // checkBudget returns no violation when checkTotals produced no total (a
      // currency fault already rejected the proposal) -- there is no total to
      // compare against. Recording that as passed = true would be a lie.
      const [row] = await sql`
        insert into gate_results (proposal_id, conversation_id, gate, passed)
        values (null, ${c!.id}, 'budget', null)
        returning passed`
      expect(row!.passed).toBeNull()
    })
  })
})

/**
 * The column comment on `gate_results.passed` is an audit CONTRACT: the next
 * slice reads this table and will trust the comment instead of re-deriving the
 * rule from the pipeline. 0005's version said NULL meant "not evaluated because
 * a prerequisite gate failed" — a row the pipeline never writes, since a gate
 * skipped by an earlier failure writes no row at all — so a reader following it
 * would have mis-read every NULL row in the table.
 *
 * A wrong comment is worse than none, because it is trusted instead of checked.
 * These tests are the drift guard in both directions: change a `NOT_EVALUATED`
 * string in the code without a new migration, or revert the comment, and they
 * fail.
 */
describeDb('0006 gate_results.passed comment — the audit contract', () => {
  async function comment(sql: any, column: string): Promise<string> {
    const [row] = await sql<{ comment: string | null }[]>`
      select col_description(a.attrelid, a.attnum) as comment
        from pg_attribute a
       where a.attrelid = 'public.gate_results'::regclass and a.attname = ${column}`
    return row?.comment ?? ''
  }

  it('names every not-evaluated reason the pipeline can actually write', async () => {
    await withTestDb(async (sql) => {
      const passed = await comment(sql, 'passed')
      for (const reason of Object.values(NOT_EVALUATED)) {
        expect(passed).toContain(reason)
      }
      // Exactly three, so a fourth added in code without a migration is caught.
      expect(Object.values(NOT_EVALUATED)).toHaveLength(3)
    })
  })

  it('states that a skipped gate writes NO row, not a NULL one', async () => {
    await withTestDb(async (sql) => {
      const passed = await comment(sql, 'passed')
      expect(passed).toContain('NO ROW')
      // 0005's wording described a row that is never written.
      expect(passed).not.toContain('prerequisite')
    })
  })

  it('documents all three verdicts, and detail\'s dependence on them', async () => {
    await withTestDb(async (sql) => {
      const passed = await comment(sql, 'passed')
      for (const verdict of ['TRUE:', 'FALSE:', 'NULL:']) expect(passed).toContain(verdict)
      expect(await comment(sql, 'detail')).toContain('Always NULL when passed = TRUE')
    })
  })
})

/**
 * 0008. Two whole-branch defects: three foreign-key child columns with no
 * index, and a hazard documented only in migration history.
 */
describeDb('0008 turn_id indexes and the daily_usage RLS warning', () => {
  /**
   * §6 requires an index on every FK child column. 0005 fixed this class of
   * defect for `gate_results.conversation_id` but the audit stopped there, so
   * all three tables 0004 created still referenced `turns(id)` with nothing to
   * serve the parent-side `on delete set null`.
   *
   * Asserted per table rather than as a count, so a migration that indexed one
   * and forgot two fails naming the ones it missed.
   */
  it.each(['tool_results', 'proposals', 'gate_results', 'link_clicks'])(
    'indexes %s.turn_id, the FK child column', async (table) => {
      await withTestDb(async (sql) => {
        const rows = await sql<{ indexdef: string }[]>`
          select indexdef from pg_indexes
           where schemaname = 'public' and tablename = ${table}`
        // Leading column must be turn_id: an index that merely MENTIONS the
        // column (say `(conversation_id, turn_id)`) cannot serve a turn_id-only
        // lookup, which is exactly the defect 0005's own note warned about for
        // `turns_sweeper`.
        expect(rows.some((r) => /\(turn_id[),]/.test(r.indexdef))).toBe(true)
      })
    })

  /**
   * The catalogue-wide audit, rather than a hand-kept list of tables.
   *
   * The finding this migration answers named THREE tables; re-running the audit
   * against the live catalogue afterwards turned up a fourth (`link_clicks`) in
   * the same migration with the same defect. The enumeration was the bug. So
   * this asserts the whole set, and the two known exceptions are named
   * explicitly with a reason — an unindexed FK child column added anywhere from
   * here on fails this test rather than waiting for someone to think to look.
   *
   * Exact-set equality, deliberately. If the two plan-1 columns below are ever
   * indexed, this fails and the list must be shortened — which is the correct
   * outcome, because a stale "known exceptions" list is how a fixed defect goes
   * on being described as accepted.
   */
  it('leaves no foreign-key child column unindexed except the two known plan-1 ones', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ child: string }[]>`
        select c.conrelid::regclass::text || '.' || a.attname as child
          from pg_constraint c
          join unnest(c.conkey) with ordinality k(attnum, ord) on true
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
         where c.contype = 'f'
           and c.connamespace = 'public'::regnamespace
           and k.ord = 1
           and not exists (
             select 1 from pg_index i
              where i.indrelid = c.conrelid and i.indkey[0] = a.attnum
           )
         order by child`
      // `messages.turn_id` and `agent_events.turn_id` are migration 0001's
      // (plan 1's harness tables), outside this branch's scope. Same defect,
      // reported rather than silently changed.
      expect(rows.map((r) => r.child)).toEqual(['agent_events.turn_id', 'messages.turn_id'])
    })
  })

  /**
   * The table comment is a CONTRACT, on the same precedent as
   * `gate_results.passed` in 0006: a policy author reads the table, not the
   * migration history, and 0003's warning about this exact hazard lives only in
   * a migration nobody opens. Pinned on the load-bearing words, so a comment
   * rewritten into something vaguer fails.
   */
  it('warns on the daily_usage TABLE that a per-user RLS policy silently breaks the global ceiling', async () => {
    await withTestDb(async (sql) => {
      const [row] = await sql<{ comment: string | null }[]>`
        select obj_description('public.daily_usage'::regclass, 'pg_class') as comment`
      const c = row?.comment ?? ''
      expect(c).toContain('row level security')
      expect(c).toContain('ALL users')
      expect(c).toContain('SILENTLY')
      // Names the mechanism, not just the risk: without the remedy the warning
      // tells a reader to worry and not what to do.
      expect(c).toContain('bypassrls')
    })
  })
})

/**
 * 0013. `round` is derived per TURN, not per conversation:
 * `countPriorGateRuns` (src/repo/toolCalls.ts) filters `where turn_id = ...`,
 * so it resets to 0 on every turn. Without a uniqueness rule, two `runGates`
 * calls that land on the same (turn, round) write two full seven-row sets and
 * every `group by gate` fire-rate double-counts. Plan 3b's `revise_component`
 * creates multiple rounds per turn by design, so this has to hold before that
 * lands.
 *
 * `seedTurn` creates turns with status 'done' (not the default 'queued') so
 * that `seedAnotherTurn` can add a second turn to the SAME conversation
 * without colliding with `turns_one_active_per_conversation`, the partial
 * unique index that allows only one queued-or-running turn per conversation.
 */
describeDb('0013 gate_results round uniqueness', () => {
  async function seedTurn(sql: any): Promise<{ conversationId: string; turnId: string }> {
    const userId = '00000000-0000-4000-8000-000000000009'
    const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
    const conversationId = c!.id as string
    const [t] = await sql`
      insert into turns (conversation_id, user_id, idempotency_key, status)
      values (${conversationId}, ${userId}, 'seed-1', 'done') returning id`
    return { conversationId, turnId: t!.id as string }
  }

  async function seedAnotherTurn(sql: any, conversationId: string): Promise<string> {
    const [conv] = await sql`select user_id from conversations where id = ${conversationId}`
    const [t] = await sql`
      insert into turns (conversation_id, user_id, idempotency_key, status)
      values (${conversationId}, ${conv!.user_id}, 'seed-2', 'done') returning id`
    return t!.id as string
  }

  it('rejects a second gate row for the same turn, round and gate', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seedTurn(sql)
      const write = () => recordGateResults(sql, {
        conversationId, turnId, proposalId: null, round: 0,
        results: [{ gate: 'provenance', passed: false, detail: 'x', sourceIds: [] }],
      })
      await write()
      await expect(write()).rejects.toThrow(/unique|duplicate/i)
    })
  })

  // The one that proves the key is TURN-scoped, not conversation-scoped. round
  // resets to 0 on every turn, so a conversation-scoped key would reject this
  // turn's legitimate round 0 as a collision with the first turn's round 0.
  it('allows round 0 again in a different turn of the same conversation', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId: t1 } = await seedTurn(sql)
      const t2 = await seedAnotherTurn(sql, conversationId)
      const row = { gate: 'provenance' as const, passed: true as const, detail: null, sourceIds: [] }
      await recordGateResults(sql, {
        conversationId, turnId: t1, proposalId: null, round: 0, results: [row],
      })
      await expect(
        recordGateResults(sql, {
          conversationId, turnId: t2, proposalId: null, round: 0, results: [row],
        }),
      ).resolves.not.toThrow()
    })
  })

  it('allows a second round in the same turn', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seedTurn(sql)
      const row = { gate: 'provenance' as const, passed: true as const, detail: null, sourceIds: [] }
      await recordGateResults(sql, {
        conversationId, turnId, proposalId: null, round: 0, results: [row],
      })
      await expect(
        recordGateResults(sql, {
          conversationId, turnId, proposalId: null, round: 1, results: [row],
        }),
      ).resolves.not.toThrow()
    })
  })
})
