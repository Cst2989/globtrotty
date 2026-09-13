import { describe, expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { countSupplierCalls, assertSupplierBudget, SUPPLIER_DOORS } from '../src/tools/supplierBudget.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { TOOLS } from '../src/tools/registry.js'

describe('DEFAULT_LIMITS', () => {
  it('carries a per-turn supplier-call ceiling', () => {
    expect(DEFAULT_LIMITS.maxSupplierCallsPerTurn).toBe(12)
  })
})

describeDb('supplier budget', () => {
  const seedTurn = async (sql: any, n: string) => {
    const userId = `00000000-0000-4000-8000-0000000006${n}`
    const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
    const [t] = await sql`
      insert into turns (conversation_id, user_id, idempotency_key, status)
      values (${c!.id}, ${userId}, ${'sb' + n}, 'running') returning id`
    return { turnId: t!.id as string }
  }
  const addCall = (sql: any, turnId: string, id: string, name: string, status = 'done') => sql`
    insert into tool_calls (turn_id, call_id, name, status)
    values (${turnId}, ${id}, ${name}, ${status})`

  it('counts only api-door tools, not code-door ones', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seedTurn(sql, '01')
      await addCall(sql, turnId, 'a', 'explore_flights')
      await addCall(sql, turnId, 'b', 'explore_hotels')
      await addCall(sql, turnId, 'c', 'ask_user')            // code door
      await addCall(sql, turnId, 'd', 'update_requirements') // code door
      expect(await countSupplierCalls(sql, turnId)).toBe(2)
    })
  })

  it('scopes strictly to one turn', async () => {
    await withTestDb(async (sql) => {
      const a = await seedTurn(sql, '02')
      const b = await seedTurn(sql, '03')
      await addCall(sql, a.turnId, 'a', 'explore_flights')
      expect(await countSupplierCalls(sql, b.turnId)).toBe(0)
    })
  })

  it('passes at the ceiling and fails one over — both sides of the boundary', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seedTurn(sql, '04')
      for (let i = 0; i < 3; i++) await addCall(sql, turnId, `c${i}`, 'explore_flights')
      expect(await assertSupplierBudget(sql, turnId, 4)).toEqual({ ok: true })
      expect(await assertSupplierBudget(sql, turnId, 3)).toEqual({ ok: false, used: 3, max: 3 })
    })
  })

  it('counts a pending call — the worker writes the row BEFORE executing, so a call that died mid-flight still costs quota', async () => {
    // This is the load-bearing bias documented on countSupplierCalls: the
    // query is deliberately unfiltered by status. Seeding only 'done' rows
    // (as every other test in this file does) would let a regression that
    // adds `and status = 'done'` to the query pass every other test here —
    // this is the one that catches it.
    await withTestDb(async (sql) => {
      const { turnId } = await seedTurn(sql, '05')
      await addCall(sql, turnId, 'a', 'explore_flights', 'done')
      await addCall(sql, turnId, 'b', 'explore_hotels', 'pending')
      expect(await countSupplierCalls(sql, turnId)).toBe(2)
    })
  })

})

// Outside describeDb on purpose: none of these need a database, and the
// first draft's version was skipped offline for no reason.
describe('SUPPLIER_DOORS tracks the registry\'s api-door tools, plus known non-api exceptions', () => {
  // `hand_off_to_booking` is a `code`-door tool that still calls
  // `Supplier.quote` once per item, so it is on SUPPLIER_DOORS on purpose —
  // named here, rather than folded silently into the set comparison below,
  // so an api-door tool added without a corresponding SUPPLIER_DOORS entry
  // still fails this test instead of being mistaken for another deliberate
  // exception.
  // `research_destination` is a `worker`-door tool (its result is a scout's
  // prose, not ours) that still reaches a metered third party — the model
  // provider's own web-search server tool — so it belongs here too.
  const NON_API_SUPPLIER_TOOLS = ['hand_off_to_booking', 'research_destination']

  it('lists exactly the tools registered with door: "api", plus the named exceptions — no more, no fewer', () => {
    // SUPPLIER_DOORS is maintained BY HAND, deliberately separate from TOOLS'
    // `door` field (src/tools/supplierBudget.ts): `door` answers a
    // fencing/provenance question, this list answers a cost/rate-limit
    // question, and coupling them by default was reviewed and rejected. That
    // means nothing derives one from the other, so nothing catches them
    // drifting apart — a new api-door tool (car rental, activities search...)
    // would be fenced correctly and cost NOTHING against the budget, with no
    // error, just an unmetered hammering of the supplier.
    //
    // If this test fails: do NOT "fix" it by deriving SUPPLIER_DOORS from
    // TOOLS' door field — that coupling was deliberately rejected. Instead,
    // decide whether the new/changed api-door tool actually reaches a
    // metered, rate-limited third party, and if so add it BY HAND to
    // SUPPLIER_DOORS in src/tools/supplierBudget.ts (and, if it is not an
    // api-door tool, to NON_API_SUPPLIER_TOOLS above).
    const apiDoorTools = Object.values(TOOLS)
      .filter((t) => t.door === 'api')
      .map((t) => t.name)

    expect(new Set(SUPPLIER_DOORS)).toEqual(new Set([...apiDoorTools, ...NON_API_SUPPLIER_TOOLS]))
    // Also pin there are no duplicates in the hand-maintained list itself.
    expect(SUPPLIER_DOORS.length).toBe(new Set(SUPPLIER_DOORS).size)
  })
})

describe('countSupplierCalls fails closed', () => {
  it('refuses to assume zero when the count query returns no row', async () => {
    // The discriminating case. `sql` here is CALLABLE — a tagged template that
    // resolves to an empty array — so nothing throws on its own: the only way
    // this test passes is if the implementation itself denies. An
    // implementation ending `rows[0]?.n ?? 0` returns 0 and fails here, which
    // is exactly the wrong answer the lint rule exists to prevent.
    const emptySql = (() => Promise.resolve([])) as unknown as Parameters<typeof countSupplierCalls>[0]
    await expect(countSupplierCalls(emptySql, 'any-turn'))
      .rejects.toThrow(/refusing to assume zero/i)
  })

  it('propagates a read failure rather than swallowing it into a zero', async () => {
    const brokenSql = (() => { throw new Error('db down') }) as unknown as
      Parameters<typeof countSupplierCalls>[0]
    // The message is pinned: "it threw" would also pass against a fake that is
    // simply not a function, which proves nothing about the implementation.
    await expect(countSupplierCalls(brokenSql, 'any-turn')).rejects.toThrow(/db down/)
  })
})
