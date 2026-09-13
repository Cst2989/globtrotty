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
import {
  corpusRunner, doorRunner, ledgerRunner, mockRunner, notebookRunner, supplierRunner,
} from '../src/tools.js'
import {
  assertSupplierBudget, countSupplierCalls, SCOUT_MAX_CITIES, supplierCallCost,
} from '../src/tools/supplierBudget.js'
import { fenceResult, makeNonce } from '../src/tools/validate.js'
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

describeDb('a patch the model made up', () => {
  it('refuses a bare number through the chain, and leaves no pending row behind', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      // The deployed chain for this tool, in the order tier 3 composes it
      // (netlify/functions/run-turn-background.mts): the door, then the ledger,
      // then the notebook.
      const run = doorRunner('planning', ledgerRunner(sql, claim, notebookRunner(
        sql,
        {
          conversationId: claim.conversationId, userId: USER,
          source: () => 'user', now: () => new Date(AT),
        },
        mockRunner(),
      )))
      // `{minor, currency}` is what the tool description asks for; a bare number
      // is what a model sends when it reads "budget" and thinks in whole euros.
      const out = await run('update_requirements', { patch: { budget: 500 } }, 'toolu_np', undefined)

      // A refusal the model can act on, naming the key, and not a throw. At
      // lesson-5-2 this was a TypeError raised inside `sql.begin` on
      // `undefined.toString()`, which escaped `notebookRunner`, `ledgerRunner`
      // and `doorRunner` alike and failed the turn.
      expect(out.content).toContain('Refused: budget')
      const [row] = await sql<{ status: string }[]>`
        select status from course.tool_calls
         where turn_id = ${claim.turnId} and call_id = 'toolu_np'`
      // `done`, not `pending`. The orphaned pending row is the exact failure
      // `doorRunner` was introduced to end (src/tools.ts), and a throw out of
      // the notebook layer put one back.
      expect(row!.status).toBe('done')
      expect((await loadNotebook(sql, claim.conversationId, USER)).budget).toBeNull()
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
        .toEqual({ ok: false, used: 1, max: 1, cost: 1 })
    })
  })

  it('counts a fan-out at the cities its door may ask for', async () => {
    await withTestDb(async (sql) => {
      const claim = await claimedTurn(sql)
      // `research_destination` searches once per city, directly, without a
      // `course.tool_calls` row of its own for each one: the table keeps exactly
      // one writer and the fan-out is one call. So the one row it does leave has
      // to answer for all of them, and it answers at the registry's ceiling,
      // `cities: z.array(...).max(3)`. The row carries no input (migration 0006
      // stores turn, call, name, status and result), so three is the only honest
      // reading of it, and an overcount refuses a search that would have fitted
      // rather than admitting one that would not.
      await sql`
        insert into course.tool_calls (turn_id, call_id, name, status)
        values (${claim.turnId}, 's1-b0', 'research_destination', 'pending')`
      expect(await countSupplierCalls(sql, claim.turnId)).toBe(SCOUT_MAX_CITIES)
      // Six searches a turn, three already answered for: a second fan-out of
      // three fits exactly, and one of three plus a search does not.
      expect(await assertSupplierBudget(sql, claim.turnId, 6, 3)).toEqual({ ok: true })
      expect(await assertSupplierBudget(sql, claim.turnId, 6, 4))
        .toEqual({ ok: false, used: 3, max: 6, cost: 4 })
    })
  })
})

describe('what one call costs the supplier budget', () => {
  it('prices a fan-out by its cities and everything else by the door', () => {
    // The call about to be made can be MEASURED, because the driver holds its
    // input; a row already in the table can only be bounded. That asymmetry is
    // deliberate and it is the only reason the two numbers differ.
    expect(supplierCallCost('search_hotels', { query: 'Faro' })).toBe(1)
    expect(supplierCallCost('search_flights', {})).toBe(1)
    expect(supplierCallCost('propose_itinerary', {})).toBe(0)
    expect(supplierCallCost('research_destination', { cities: ['Faro'] })).toBe(1)
    expect(supplierCallCost('research_destination', { cities: ['Faro', 'Lisbon'] })).toBe(2)
    // Unvalidated model output reaches this: the driver checks the budget before
    // the chain validates anything. Anything it cannot read is priced at the
    // ceiling rather than at zero, which is the same direction every other
    // guardrail on this branch rounds.
    expect(supplierCallCost('research_destination', {})).toBe(SCOUT_MAX_CITIES)
    expect(supplierCallCost('research_destination', { cities: 'Faro' })).toBe(SCOUT_MAX_CITIES)
    expect(supplierCallCost('research_destination', { cities: ['a', 'b', 'c', 'd'] }))
      .toBe(SCOUT_MAX_CITIES)
  })
})

describe('the per-turn supplier budget, with nothing to read it from', () => {
  it('throws rather than reporting zero when it cannot read', async () => {
    // A budget reader that fails open is not a budget.
    await expect(countSupplierCalls(brokenSql(), 'any')).rejects.toThrow()
  })
})

describe('a trusted door that carries untrusted money', () => {
  it('does not fence a code-door rejection, and still taints what follows it', () => {
    // Two independent properties, and conflating them opens a hole exactly where
    // they differ. Fencing is about delimiter injection: whether the model can
    // tell where our words end. Taint is about provenance: whether what the model
    // is about to write down came from her or from something we read. A rule that
    // narrowed the taint to untrusted DOORS would stamp the write after this
    // rejection `'user'` and let the model raise her budget to fit the total it
    // just read.
    const rejection = 'The proposal was rejected. Fix exactly these and propose again:\n'
      + '- budget (hotel-0-4471): this trip totals EUR 1,742, over your EUR 1,500 budget'
    expect(fenceResult('propose_itinerary', 'code', rejection, makeNonce())).toBe(rejection)

    const after = provenanceFor({ state: { step: 2, messages: [
      { role: 'user', content: [{ type: 'text', text: 'Portugal, 1500 euros' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'propose_itinerary', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: rejection }] },
    ] } } as never)
    // Inferred, on the strength of the tool_result block alone, with no regard
    // to which door produced it. That is what makes the money gate hold here.
    expect(after).toBe('inferred')
  })
})
