import { describe, expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { countSupplierCalls, assertSupplierBudget } from '../src/tools/supplierBudget.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

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
  const addCall = (sql: any, turnId: string, id: string, name: string) => sql`
    insert into tool_calls (turn_id, call_id, name, status)
    values (${turnId}, ${id}, ${name}, 'done')`

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

})

// Outside describeDb on purpose: neither of these needs a database, and the
// first draft's version was skipped offline for no reason.
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
