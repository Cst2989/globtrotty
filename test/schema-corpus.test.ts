import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { NOT_EVALUATED } from '../src/gates/pipeline.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

async function comment(sql: postgres.Sql, table: string, column: string): Promise<string> {
  const [row] = await sql<{ comment: string | null }[]>`
    select col_description(a.attrelid, a.attnum) as comment
      from pg_attribute a
     where a.attrelid = ${`course.${table}`}::regclass and a.attname = ${column}`
  return row?.comment ?? ''
}

describeDb('0010 the corpus schema', () => {
  it('stores a result and reads it back by (conversation_id, source_id)', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await sql`
        insert into course.tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${USER}, 'KIWI-1', 'kiwi', 'flight', 'BER-FAO',
                ${(45400n).toString()}, 'EUR', 'total', 900, ${sql.json({ a: 1 })})`
      const [row] = await sql`
        select price_minor, currency, price_basis, fetched_at
          from course.tool_results where conversation_id = ${c!.id} and source_id = 'KIWI-1'`
      expect(BigInt(row!.price_minor as string)).toBe(45400n)
      expect(row!.currency).toBe('EUR')
      expect(row!.price_basis).toBe('total')
      expect(row!.fetched_at).toBeInstanceOf(Date)
    })
  })

  /**
   * The append-only property, asserted against the catalogue rather than
   * described in a comment. `main` has `unique (conversation_id, source_id)`
   * here and upserts into it; adding that constraint to this branch would make
   * `recordResults` fail on the second fetch of any item, and this is what says
   * so out loud.
   */
  it('has NO unique constraint on (conversation_id, source_id)', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'course' and tablename = 'tool_results'`
      const uniques = rows.filter((r) => /unique/i.test(r.indexdef) && !/tool_results_pkey/.test(r.indexdef))
      expect(uniques).toEqual([])

      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const insert = () => sql`
        insert into course.tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${USER}, 'DUP', 'mock', 'hotel', 'H',
                ${(100n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      await insert()
      await insert()
      expect(await sql`select 1 from course.tool_results where conversation_id = ${c!.id} and source_id = 'DUP'`)
        .toHaveLength(2)
    })
  })

  it('rejects a negative price, an unknown price basis and a zero ttl', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      // Each rejected insert gets its OWN savepoint. Run inside one transaction,
      // the first violation aborts it and every later assertion sees "current
      // transaction is aborted" instead of the constraint it meant to exercise,
      // so the second and third checks would prove nothing.
      const rejects = (basis: string, price: bigint, ttl: number) =>
        sql.begin((tx) => tx`
          insert into course.tool_results
            (conversation_id, user_id, source_id, supplier, kind, name,
             price_minor, currency, price_basis, ttl_seconds, payload)
          values (${c!.id}, ${USER}, ${`S-${basis}-${price}-${ttl}`}, 'mock', 'hotel', 'H',
                  ${price.toString()}, 'EUR', ${basis}, ${ttl}, ${sql.json({})})`)

      await expect(rejects('total', -1n, 900)).rejects.toThrow(/check constraint/i)
      await expect(rejects('wholesale', 1n, 900)).rejects.toThrow(/check constraint/i)
      // ttl_seconds must be strictly positive: an item quotable for zero seconds
      // is an item the freshness gate would reject on arrival, which is a row
      // nobody could have meant to write.
      await expect(rejects('total', 1n, 0)).rejects.toThrow(/check constraint/i)
      const [ok] = await sql`select 1 as ok`
      expect(ok!.ok).toBe(1)                       // the savepoints rolled back cleanly
    })
  })

  it('rejects a kind nobody defined', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await expect(sql.begin((tx) => tx`
        insert into course.tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${USER}, 'CAR', 'mock', 'car', 'H',
                ${(1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`))
        .rejects.toThrow(/check constraint/i)
    })
  })

  it('refuses a result attached to another user\'s conversation', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      // The composite foreign key, which is the only isolation this table has
      // until lesson 5.7.
      await expect(sql.begin((tx) => tx`
        insert into course.tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${randomUUID()}, 'X', 'mock', 'hotel', 'H',
                ${(1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`))
        .rejects.toThrow(/foreign key/i)
    })
  })

  it('cascades results when the conversation is deleted', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await sql`
        insert into course.tool_results
          (conversation_id, user_id, source_id, supplier, kind, name,
           price_minor, currency, price_basis, ttl_seconds, payload)
        values (${c!.id}, ${USER}, 'X', 'mock', 'hotel', 'H',
                ${(1n).toString()}, 'EUR', 'total', 900, ${sql.json({})})`
      await sql`delete from course.conversations where id = ${c!.id}`
      expect(await sql`select 1 from course.tool_results where conversation_id = ${c!.id}`).toHaveLength(0)
    })
  })

  it('indexes the rehydration path and the turn_id child column', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'course' and tablename = 'tool_results'`
      // Leading column must be conversation_id: rehydration always knows the
      // conversation and asks for many source ids at once.
      expect(rows.some((r) => /\(conversation_id, source_id/.test(r.indexdef))).toBe(true)
      // And turn_id must LEAD its own index. One that merely mentions the
      // column cannot serve a turn_id-only lookup, which is the trap 0009 was
      // written to fix for the sweeper.
      expect(rows.some((r) => /\(turn_id[),]/.test(r.indexdef))).toBe(true)
    })
  })

  it('says on the table that row isolation is not enforced here yet', async () => {
    await withTestDb(async (sql) => {
      const [row] = await sql<{ comment: string | null }[]>`
        select obj_description('course.tool_results'::regclass, 'pg_class') as comment`
      const c = row?.comment ?? ''
      // A policy author reads the table, not the migration history. Pinned on
      // the load-bearing words, so a comment rewritten into something vaguer
      // fails rather than passing.
      expect(c).toContain('NOT enforced')
      expect(c).toContain('lesson 5.7')
    })
  })
})

describeDb('0011 the turn-spend comment, an audit contract', () => {
  it('names all three writers, not the two 0005 knew about', async () => {
    await withTestDb(async (sql) => {
      const text = await comment(sql, 'turns', 'spend_usd_micros')
      for (const writer of ['completeTurn', 'failTurn', 'releaseForContinuation']) {
        expect(text).toContain(writer)
      }
    })
  })

  it('says this column is never a supplier price', async () => {
    await withTestDb(async (sql) => {
      const text = await comment(sql, 'turns', 'spend_usd_micros')
      expect(text).toContain('tool_results.price_minor')
      expect(text).toContain('neither converts')
    })
  })
})

describeDb('0012 the gate_results verdicts, an audit contract', () => {
  it('names every not-evaluated reason the pipeline can actually write', async () => {
    await withTestDb(async (sql) => {
      const passed = await comment(sql, 'gate_results', 'passed')
      for (const reason of Object.values(NOT_EVALUATED)) expect(passed).toContain(reason)
      // Exactly three, so a fourth added in code without a migration is caught.
      expect(Object.values(NOT_EVALUATED)).toHaveLength(3)
    })
  })

  it('states that a skipped gate writes NO row, not a null one', async () => {
    await withTestDb(async (sql) => {
      const passed = await comment(sql, 'gate_results', 'passed')
      expect(passed).toContain('NO ROW')
      for (const verdict of ['TRUE:', 'FALSE:', 'NULL:']) expect(passed).toContain(verdict)
      expect(await comment(sql, 'gate_results', 'detail')).toContain('Always NULL when passed = TRUE')
    })
  })

  it('accepts the three verdicts and refuses a gate name nobody defined', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      for (const [gate, passed] of [['provenance', true], ['budget', null], ['slots', false]] as const) {
        await sql`insert into course.gate_results (conversation_id, user_id, gate, passed)
                  values (${c!.id}, ${USER}, ${gate}, ${passed})`
      }
      const rows = await sql`select passed from course.gate_results
                              where conversation_id = ${c!.id} order by seq`
      expect(rows.map((r) => r.passed)).toEqual([true, null, false])
      // Own savepoint: a failing insert aborts the enclosing transaction, and
      // the assertion after it would see "current transaction is aborted"
      // instead of the constraint it meant to exercise.
      await expect(sql.begin((tx) => tx`
        insert into course.gate_results (conversation_id, user_id, gate, passed)
        values (${c!.id}, ${USER}, 'vibes', true)`)).rejects.toThrow(/check constraint/i)
      // 'reviewer' is accepted although GateName does not include it: the seam
      // for module 5's reviewer seat costs nothing now and a migration later.
      await sql`insert into course.gate_results (conversation_id, user_id, gate, passed)
                values (${c!.id}, ${USER}, 'reviewer', true)`
    })
  })

  it('cascades a gate row with a null proposal_id when the conversation is deleted', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      // Exactly what runGates writes: gates run before a proposal row exists, so
      // proposal_id is null and conversation_id is the only path back.
      await sql`insert into course.gate_results (conversation_id, user_id, proposal_id, gate, passed)
                values (${c!.id}, ${USER}, null, 'provenance', true)`
      await sql`delete from course.conversations where id = ${c!.id}`
      expect(await sql`select 1 from course.gate_results where conversation_id = ${c!.id}`).toHaveLength(0)
    })
  })
})
