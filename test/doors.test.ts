import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { provenanceFor } from '../src/agents/driver.js'
import { constraintsFromNotebook } from '../src/gates/notebookConstraints.js'
import { proposalRunner } from '../src/gates/runner.js'
import { money } from '../src/money.js'
import { applyRequirements, emptyNotebook } from '../src/notebook.js'
import { applyRequirementsPatch, loadNotebook } from '../src/repo/notebook.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn, type Claim } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import { corpusRunner, doorRunner, ledgerRunner, mockRunner, supplierRunner } from '../src/tools.js'
import { assertSupplierBudget, countSupplierCalls } from '../src/tools/supplierBudget.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()
const AT = '2026-08-29T10:00:00Z'

/**
 * A conversation with a claimed, running turn on it.
 *
 * A claim rather than three loose ids because `recordResults` is a fenced write
 * (src/repo/toolResults.ts, lesson 4.3): it appends only while `course.turns`
 * shows this turn `running` at this claim's `attempts`, so a corpus row that
 * belongs to nobody is not a state a test can produce.
 */
async function claimedTurn(sql: postgres.Sql): Promise<Claim> {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${c!.id}, ${USER}, ${randomUUID()}) returning id`
  await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content)
    values (${c!.id}, ${USER}, ${t!.id}, 'user', 'a week in Portugal')`
  return (await claimTurn(sql, t!.id as string))!
}

/**
 * A `postgres.Sql` whose every query rejects. Enough of the shape for the one
 * reader under test: `countSupplierCalls` calls it as a tagged template and
 * awaits the result, and nothing else on the type is reached.
 */
function brokenSql(): postgres.Sql {
  return (() => Promise.reject(new Error('connection refused'))) as unknown as postgres.Sql
}

describeDb('what the gates can judge at lesson-5-1', () => {
  it('records budget as not evaluated on a proposal nobody could afford', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const conversationId = claim.conversationId
      const params = {
        kind: 'hotel' as const, query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
        adults: 2, currency: 'EUR',
      }
      const items = await mockSuppliers().hotel.search(params)
      await recordResults(sql, claim, { params, items })

      // The same mapper both live drivers use, over the same empty notebook they
      // both build, because nothing on this branch stores one.
      const notebook = constraintsFromNotebook(emptyNotebook(), '2026-08-29')
      expect(notebook.budget).toBeNull()
      expect(notebook.window).toBeNull()

      const run = proposalRunner(
        sql,
        // The real clock, not the course's fixed date: the mock stamps
        // `fetchedAt` with the clock it is running on, and `checkFreshness`
        // refuses a price quoted in the future as firmly as a stale one, so a
        // 2026-08-29 gate clock would report the freshness gate rather than the
        // two this demonstration is about.
        { conversationId, userId: USER, turnId: claim.turnId, notebook, now: () => new Date() },
        corpusRunner(sql, claim, supplierRunner(mockSuppliers(), 'EUR')),
      )
      await run('propose_itinerary',
        { refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }] }, 'demo-1')

      const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null }[]>`
        select gate, passed, detail from course.gate_results
         where conversation_id = ${conversationId} order by gate`
      const byGate = Object.fromEntries(rows.map((r) => [r.gate, r]))
      // Two of the six reach no verdict, on every proposal, on both paths a
      // reader can run. The gate that exists to stop a trip she cannot afford
      // has never once judged a budget in production.
      expect(byGate.budget!.passed).toBeNull()
      expect(byGate.dates!.passed).toBeNull()
      console.log(rows.map((r) => `${r.gate}=${r.passed ?? 'null'} ${r.detail ?? ''}`).join('\n'))
    })
  })
})

describeDb('what the gates can judge from lesson 5.2', () => {
  it('judges her budget, and refuses a trip that does not fit it', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const conversationId = claim.conversationId
      await applyRequirementsPatch(sql, {
        conversationId, userId: USER, at: AT, source: 'user',
        patch: { budget: money(20_000n, 'EUR'), month: 'September', nights: 7 },
      })
      // The same search and the same proposal as the opening demonstration, so
      // the only thing that has changed between the two runs is that the
      // notebook has a column and a reader.
      const params = {
        kind: 'hotel' as const, query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
        adults: 2, currency: 'EUR',
      }
      const items = await mockSuppliers().hotel.search(params)
      await recordResults(sql, claim, { params, items })
      const notebook = constraintsFromNotebook(
        await loadNotebook(sql, conversationId, USER), '2026-08-29')
      // The two fields the opening demonstration read back as null.
      expect(notebook.budget!.minor).toBe(20_000n)
      expect(notebook.window).not.toBeNull()
      const run = proposalRunner(
        sql,
        // The real clock, not the course's fixed date: the mock stamps
        // `fetchedAt` with the clock it is running on, and `checkFreshness`
        // refuses a price quoted in the future as firmly as a stale one, so a
        // 2026-08-29 gate clock would report the freshness gate rather than the
        // two this demonstration is about.
        { conversationId, userId: USER, turnId: claim.turnId, notebook, now: () => new Date() },
        corpusRunner(sql, claim, supplierRunner(mockSuppliers(), 'EUR')),
      )
      await run('propose_itinerary',
        { refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }] }, 'demo-1')

      const rows = await sql<{ gate: string; passed: boolean | null; detail: string | null }[]>`
        select gate, passed, detail from course.gate_results
         where conversation_id = ${conversationId} order by gate`
      const byGate = Object.fromEntries(rows.map((r) => [r.gate, r]))
      // The two gates that recorded `not evaluated` on every proposal this
      // branch had ever made now both reach a verdict, and the budget gate
      // reaches the right one.
      expect(byGate.budget!.passed).toBe(false)
      expect(byGate.dates!.passed).not.toBeNull()
      console.log(rows.map((r) => `${r.gate}=${r.passed ?? 'null'} ${r.detail ?? ''}`).join('\n'))
    })
  })

  it('stamps a patch made after a search as inferred, so it cannot raise her budget', () => {
    // The exploit needs no adversary: the model reads a supplier price above her
    // budget and raises the budget to fit its own plan. Derived provenance is
    // what stops it, and this is the case that proves the branch is reachable.
    const before = provenanceFor({ state: { step: 0, messages: [
      { role: 'user', content: [{ type: 'text', text: 'Portugal, 1500 euros' }] },
    ] } } as never)
    const after = provenanceFor({ state: { step: 1, messages: [
      { role: 'user', content: [{ type: 'text', text: 'Portugal, 1500 euros' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_hotels', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[]' }] },
    ] } } as never)
    expect(before).toBe('user')
    expect(after).toBe('inferred')
    // And what that stamp costs the model, pinned rather than described: her own
    // budget is closed to it, and a constraint nobody stated may be tightened
    // and not loosened (src/notebook.ts).
    const hers = applyRequirements(emptyNotebook(), { budget: money(150_000n, 'EUR') }, 'user', AT)
    expect(applyRequirements(hers.next, { budget: money(300_000n, 'EUR') }, after, AT).rejected)
      .toEqual(['budget'])
    const ours = applyRequirements(emptyNotebook(), { budget: money(150_000n, 'EUR') }, 'inferred', AT)
    expect(applyRequirements(ours.next, { budget: money(300_000n, 'EUR') }, after, AT).rejected)
      .toEqual(['budget'])
    expect(applyRequirements(ours.next, { budget: money(120_000n, 'EUR') }, after, AT).rejected)
      .toEqual([])
  })
})

describeDb('the door in front of the ledger', () => {
  it('refuses a tool this desk does not hold before any row is written', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const run = doorRunner('planning', ledgerRunner(sql, claim, mockRunner()))
      const out = await run('wire_money', { amount: 1 }, 'toolu_01', undefined)
      expect(out.isError).toBe(true)
      expect(out.content).toContain('No tool named "wire_money"')
      // Nothing durable happened. At lesson-5-1 this call reached the supplier
      // layer and left a row behind on the way.
      const rows = await sql`select 1 from course.tool_calls where turn_id = ${claim.turnId}`
      expect(rows).toHaveLength(0)
    })
  })

  it('fences an api result on the way out and stores the raw one', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      const run = doorRunner('planning', ledgerRunner(sql, claim, mockRunner()))
      const search = await run('search_hotels',
        { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 },
        'toolu_02', undefined)
      expect(search.content).toContain('trust="untrusted"')
      // And the stored result is the RAW one, so a replay is fenced afresh
      // rather than replaying a fence that was built for a different call.
      const [row] = await sql<{ result: { content: string } }[]>`
        select result from course.tool_calls where turn_id = ${claim.turnId} and call_id = 'toolu_02'`
      expect(row!.result.content).not.toContain('trust="untrusted"')
    })
  })
})

describeDb('the per-turn supplier budget', () => {
  it('counts a call that started and never finished', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      // A row written by beginToolCall and never finished: a call that fired and
      // whose process died. This is the case that matters most, and it is the
      // one an implementation filtering on `status = 'done'` would miss while
      // passing every other test in this file.
      // No user_id column: course.tool_calls is keyed on (turn_id, call_id)
      // and carries none (migration 0006).
      await sql`
        insert into course.tool_calls (turn_id, call_id, name, status)
        values (${claim.turnId}, 'toolu_dead', 'search_hotels', 'pending')`
      expect(await countSupplierCalls(sql, claim.turnId)).toBe(1)
      expect(await assertSupplierBudget(sql, claim.turnId, 1))
        .toEqual({ ok: false, used: 1, max: 1 })
    })
  })
})

describe('the per-turn supplier budget, with nothing to read it from', () => {
  it('throws rather than reporting zero when it cannot read', async () => {
    // A budget reader that fails open is not a budget.
    await expect(countSupplierCalls(brokenSql(), 'any')).rejects.toThrow()
  })
})
