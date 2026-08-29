import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

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

  it('rejects a duplicate (conversation_id, source_id)', async () => {
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
      await expect(ins()).rejects.toThrow(/duplicate key|unique/i)
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

  it('accepts passed = null, meaning "not evaluated because a prerequisite gate failed"', async () => {
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
