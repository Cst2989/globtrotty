import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { money } from '../src/money.js'
import { AmbiguousToolCallError } from '../src/repo/toolCalls.js'
import { recordResults, rehydrate } from '../src/repo/toolResults.js'
import { claimTurn, FencedError, HEARTBEAT_STALE, type Claim } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { FlightSearch } from '../src/supplier/types.js'
import { corpusRunner, supplierRunner } from '../src/tools.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps, silentFor } from './helpers/turns.js'

const USER = randomUUID()

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

const hotelCall = { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }

/**
 * A claimed turn, plus params nobody else in this file uses.
 *
 * A claim rather than three loose ids, because `recordResults` is a fenced
 * write: it appends only while `course.turns` still shows this turn `running`
 * at this claim's `attempts`, so there is no such thing here as a corpus row
 * written by nobody. `submitMessage` then `claimTurn` is the same two lines
 * `test/tool-calls.test.ts`'s `seedTurn` uses, for the same reason.
 *
 * `departureDate` is the field to vary, and it has to be one the hash actually
 * reads: `MockSupplier` derives every sourceId from a hash of the search alone
 * and never from the conversation, so two conversations seeded from ONE params
 * object get the SAME ids and a scoping test then passes without regard to
 * whether the code scopes anything. `MockSupplier`'s flight hash is
 * `seed:from:to:departureDate` (src/supplier/mock.ts), so varying `flexDays`
 * would change the recorded search and leave every sourceId identical. `n`
 * stays under 20 so the date is a real September day.
 */
async function convo(sql: postgres.Sql, n: number) {
  const submitted = await submitMessage(
    handlerDeps(sql),
    { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: randomUUID() },
  )
  const claim = (await claimTurn(sql, submitted.turnId!))!
  const departureDate = `2026-09-${String(n).padStart(2, '0')}`
  return { claim, conversationId: claim.conversationId, params: { ...params, departureDate } }
}

describeDb('the provenance corpus', () => {
  it('records a search and rehydrates it losslessly', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 1)
      const items = await mockSuppliers().flight.search(p)
      expect(await recordResults(sql, claim, { params: p, items })).toBe(items.length)

      const got = await rehydrate(sql, conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(items.length)
      const first = got.get(items[0]!.sourceId)!
      // Every field, because "losslessly" is the claim. A round trip that
      // dropped `ttlSeconds` would leave the freshness gate with nothing to
      // compare against and would still pass a spot check on the price.
      expect(first.sourceId).toBe(items[0]!.sourceId)
      expect(first.supplier).toBe(items[0]!.supplier)
      expect(first.kind).toBe(items[0]!.kind)
      expect(first.name).toBe(items[0]!.name)
      expect(first.price.minor).toBe(items[0]!.price.minor)
      expect(first.price.currency).toBe(items[0]!.price.currency)
      expect(first.priceBasis).toBe(items[0]!.priceBasis)
      expect(first.ttlSeconds).toBe(items[0]!.ttlSeconds)
      expect(first.bookingUrl).toBe(items[0]!.bookingUrl)
      expect(first.fetchedAt).toBeInstanceOf(Date)
      expect(first.fetchedAt.getTime()).toBe(items[0]!.fetchedAt.getTime())
      expect(first.detail).toEqual(items[0]!.detail)
    })
  })

  /**
   * The append-only property, stated as a test rather than as a comment.
   *
   * `main` keys this table `unique (conversation_id, source_id)` and upserts,
   * and its own file says at length that this is a deliberate deviation from
   * "untrimmed, append-only" and that converting is owed rather than optional:
   * every re-quote before the conversion destroys one historical price,
   * silently and unrecoverably. This branch has no live table and no history to
   * lose, so it takes the conversion at the start instead of owing it.
   */
  it('keeps the old row when a price moves, rather than overwriting it', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 2)
      const [item] = await mockSuppliers().flight.search(p)
      await recordResults(sql, claim, { params: p, items: [item!] })

      const later = {
        ...item!,
        price: money(item!.price.minor + 1000n, item!.price.currency),
        fetchedAt: new Date(item!.fetchedAt.getTime() + 60_000),
      }
      expect(await recordResults(sql, claim, { params: p, items: [later] })).toBe(1)

      // Two rows, not one. An upsert implementation returns 1 here.
      const rows = await sql`
        select price_minor from course.tool_results
         where conversation_id = ${conversationId} and source_id = ${item!.sourceId}
         order by seq`
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => BigInt(r.price_minor as string)))
        .toEqual([item!.price.minor, item!.price.minor + 1000n])

      // And rehydration reads the newest of them, which is the only reason the
      // older one being kept costs nothing.
      const got = await rehydrate(sql, conversationId, [item!.sourceId])
      expect(got.get(item!.sourceId)!.price.minor).toBe(item!.price.minor + 1000n)
    })
  })

  it('reads the newest fetch even when the older one was written last', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 3)
      const [item] = await mockSuppliers().flight.search(p)
      const older = { ...item!, price: money(11_100n, 'EUR'), fetchedAt: new Date('2026-08-16T10:00:00Z') }
      const newer = { ...item!, price: money(22_200n, 'EUR'), fetchedAt: new Date('2026-08-16T11:00:00Z') }

      // Newest FIRST in the batch, so an implementation that took the last row
      // it happened to write, or ordered by seq alone, gets this wrong.
      await recordResults(sql, claim, { params: p, items: [newer, older] })
      const got = await rehydrate(sql, conversationId, [item!.sourceId])
      expect(got.get(item!.sourceId)!.price.minor).toBe(22_200n)
      expect(got.get(item!.sourceId)!.fetchedAt.toISOString()).toBe('2026-08-16T11:00:00.000Z')
    })
  })

  it('breaks a tie on two identical timestamps by taking the later write', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 4)
      const [item] = await mockSuppliers().flight.search(p)
      const at = new Date('2026-08-16T10:00:00Z')
      // A supplier can legitimately return one native id twice in one response,
      // an itinerary under two fare families or a property listed by two OTAs,
      // and both copies carry the same fetchedAt because one call stamped them.
      // `seq` is the tiebreak, and it is why this table has one.
      await recordResults(sql, claim, {
        params: p,
        items: [{ ...item!, price: money(100n, 'EUR'), fetchedAt: at },
                { ...item!, price: money(200n, 'EUR'), fetchedAt: at }],
      })
      const got = await rehydrate(sql, conversationId, [item!.sourceId])
      expect(got.get(item!.sourceId)!.price.minor).toBe(200n)
    })
  })

  it('records every distinct id in a batch that also contains a repeat', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 5)
      const items = await mockSuppliers().flight.search(p)
      // Four in, three distinct. `main` had to deduplicate here or Postgres
      // raised "ON CONFLICT DO UPDATE command cannot affect row a second time";
      // with no unique constraint there is nothing to conflict with, so all
      // four rows land and rehydration still answers three ids.
      expect(await recordResults(sql, claim, { params: p, items: [...items, items[0]!] })).toBe(4)
      const got = await rehydrate(sql, conversationId, items.map((i) => i.sourceId))
      expect(got.size).toBe(3)
    })
  })

  it('omits an id it has never seen rather than inventing one', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 6)
      const items = await mockSuppliers().flight.search(p)
      await recordResults(sql, claim, { params: p, items })
      const got = await rehydrate(sql, conversationId, [items[0]!.sourceId, 'GHOST'])
      // A Map, so absence is a fact a caller can read. Anything that defaulted
      // a missing id would make the provenance gate impossible to write.
      expect(got.has(items[0]!.sourceId)).toBe(true)
      expect(got.has('GHOST')).toBe(false)
      expect(got.size).toBe(1)
    })
  })

  it('scopes strictly to one conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await convo(sql, 7)
      const b = await convo(sql, 8)
      const items = await mockSuppliers().flight.search(a.params)
      await recordResults(sql, a.claim, { params: a.params, items })
      // b never searched. An id seen in someone else's conversation is not
      // provenance for this one.
      expect((await rehydrate(sql, b.conversationId, items.map((i) => i.sourceId))).size).toBe(0)
    })
  })

  it('handles an empty id list without a query', async () => {
    await withTestDb(async (sql) => {
      const { conversationId } = await convo(sql, 9)
      expect((await rehydrate(sql, conversationId, [])).size).toBe(0)
    })
  })

  it('stores the search that produced the row, not only the row', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId, params: p } = await convo(sql, 10)
      const items = await mockSuppliers().flight.search(p)
      await recordResults(sql, claim, { params: p, items })
      const [row] = await sql`
        select search_params from course.tool_results
         where conversation_id = ${conversationId} order by seq limit 1`
      // Lesson 4.6 re-quotes by re-running the search that found the item, so
      // the params have to travel with the row or a re-quote has nothing to
      // re-run.
      expect(row!.search_params).toMatchObject({ kind: 'flight', from: 'BER', to: 'FAO', currency: 'EUR' })
    })
  })

  it('attaches every row to the turn that made the search, findable by turn_id alone', async () => {
    await withTestDb(async (sql) => {
      const { claim, params: p } = await convo(sql, 11)
      const items = await mockSuppliers().flight.search(p)
      await recordResults(sql, claim, { params: p, items })
      // Read back through the one column `tool_results_by_turn` (0010) indexes
      // and through nothing else. Module 7's per-turn retention has no other
      // key, and a corpus that wrote null here would satisfy every other case
      // in this file while leaving that index covering nothing.
      const rows = await sql`
        select source_id from course.tool_results where turn_id = ${claim.turnId} order by seq`
      expect(rows.map((r) => r.source_id)).toEqual(items.map((i) => i.sourceId))
    })
  })
})

describeDb('the corpus, fenced', () => {
  it('refuses to append for a turn this worker no longer owns, and lets the live worker write', async () => {
    await withTestDb(async (sql) => {
      const { claim: first, params: p } = await convo(sql, 12)
      const items = await mockSuppliers().flight.search(p)
      // The same hand-off `test/tool-calls.test.ts` stages for the ledger: the
      // first worker goes quiet, the sweeper's lease lets a second claim the
      // turn, and the first one's search comes back late.
      await silentFor(sql, first.turnId, HEARTBEAT_STALE + 30)
      const second = (await claimTurn(sql, first.turnId))!
      expect(second.attempts).toBe(2)

      await expect(recordResults(sql, first, { params: p, items })).rejects.toThrow(FencedError)
      // Zero rows, not a rolled-back write: the fenced insert matched nothing.
      // Without the fence this row would win rehydration outright, because it
      // is the NEWEST fetch for its id and nothing about it looks wrong.
      expect(await sql`select 1 from course.tool_results where turn_id = ${first.turnId}`).toHaveLength(0)

      expect(await recordResults(sql, second, { params: p, items })).toBe(items.length)
    })
  })
})

describeDb('corpusRunner', () => {
  it('writes a row per item for a search the model made', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId } = await convo(sql, 13)
      const run = corpusRunner(sql, claim, supplierRunner(mockSuppliers()))

      const outcome = await run('search_hotels', hotelCall, 's1-b0')
      expect(outcome.isError).toBe(false)

      const rows = await sql`
        select source_id, price_minor from course.tool_results
         where conversation_id = ${conversationId} order by seq`
      expect(rows).toHaveLength(3)
      // The row and the wire agree, because both came off the same item.
      const wire = JSON.parse(outcome.content) as { sourceId: string; price: { minor: string } }[]
      expect(rows.map((r) => r.source_id)).toEqual(wire.map((w) => w.sourceId))
      expect(rows.map((r) => String(r.price_minor))).toEqual(wire.map((w) => w.price.minor))
    })
  })

  it('writes nothing for a call that produced no search', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId } = await convo(sql, 14)
      const run = corpusRunner(sql, claim, supplierRunner(mockSuppliers()))
      const bad = await run('search_flights', { from: 'BER' }, 's1-b0')
      expect(bad.isError).toBe(true)
      const unknown = await run('no_such_tool', {}, 's1-b1')
      expect(unknown.isError).toBe(true)
      expect(await sql`select 1 from course.tool_results where conversation_id = ${conversationId}`).toHaveLength(0)
    })
  })

  it('ends the turn rather than hand the model a result the gate cannot read', async () => {
    await withTestDb(async (sql) => {
      const { claim, conversationId } = await convo(sql, 15)
      // The fence is how this case makes the corpus write fail, and it is the
      // failure worth staging: the search really ran, the supplier really
      // answered, and by the time the answer came back the turn belonged to
      // somebody else.
      //
      // Deliberately not a constraint violation, which is the other cheap way
      // to break the write. A failing INSERT aborts the transaction it ran in,
      // so every statement after it, the row count below included, would come
      // back `25P02 current transaction is aborted` and assert nothing. A
      // fenced insert that matches no rows is an ordinary successful statement.
      await silentFor(sql, claim.turnId, HEARTBEAT_STALE + 30)
      await claimTurn(sql, claim.turnId)

      const run = corpusRunner(sql, claim, supplierRunner(mockSuppliers()))
      await expect(run('search_hotels', hotelCall, 's1-b0')).rejects.toThrow(AmbiguousToolCallError)
      // And nothing landed for this conversation, under any source id or any
      // turn: a runner that wrote the items anyway before rethrowing, which is
      // the well-meaning fix somebody reaches for first, fails on this line.
      expect(await sql`select 1 from course.tool_results where conversation_id = ${conversationId}`)
        .toHaveLength(0)
    })
  })
})

/**
 * The count check, which needs no database and could not have one: a single
 * multi-row insert is all-or-nothing, so a short write is not a state Postgres
 * can be talked into. The check is here because every writer on this branch
 * verifies its own effect through `returning`, and the day this statement stops
 * being one statement is the day the check earns its keep.
 */
describe('corpusRunner, counting what it wrote', () => {
  const claim: Claim = {
    turnId: randomUUID(), conversationId: randomUUID(), userId: USER, attempts: 1, state: null,
  }

  it('treats a short write as a failed one rather than a partial success', async () => {
    // A stub `sql`: callable as a tagged template, answering the insert with
    // two ids for a search that produced three items.
    const shortSql = Object.assign(
      async () => [{ id: randomUUID() }, { id: randomUUID() }],
      { json: (v: unknown) => v },
    ) as unknown as postgres.Sql

    const run = corpusRunner(shortSql, claim, supplierRunner(mockSuppliers()))
    // A corpus holding two of three items answers two thirds of a proposal, and
    // the third is the one the gate cannot rehydrate. That is a failed write,
    // so it ends the turn like any other.
    await expect(run('search_hotels', hotelCall, 's1-b0')).rejects.toThrow(AmbiguousToolCallError)
  })

  it('is satisfied when every item came back', async () => {
    const wholeSql = Object.assign(
      async () => [{ id: randomUUID() }, { id: randomUUID() }, { id: randomUUID() }],
      { json: (v: unknown) => v },
    ) as unknown as postgres.Sql
    const outcome = await corpusRunner(wholeSql, claim, supplierRunner(mockSuppliers()))(
      'search_hotels', hotelCall, 's1-b0',
    )
    expect(outcome.isError).toBe(false)
  })
})
