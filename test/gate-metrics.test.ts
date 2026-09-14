import { randomUUID } from 'node:crypto'
import { gateMetrics, gateRows, OTHER_GATES } from '../src/evals/gateMetrics.js'
import { GATE_NAMES } from '../src/gates/types.js'
import { recordGateResults } from '../src/repo/gateResults.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()
// A second id at module scope, like the first, because lesson 6.4's run asks
// `gateMetrics` for several at once and one of these cases is about that.
const SECOND_USER = randomUUID()

describeDb('gate-derived metrics', () => {
  it('names every gate, including the ones that produced no rows', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await recordGateResults(sql, {
        conversationId: c!.id as string, userId: USER, turnId: null, proposalId: null, round: 0,
        results: [
          { gate: 'budget', passed: false, detail: 'over', sourceIds: [] },
          // A pass carries no detail, because `GateResultRow` pairs the two:
          // there is nothing to explain about a gate that had nothing to say.
          { gate: 'budget', passed: true, detail: null, sourceIds: [] },
          { gate: 'dates', passed: null, detail: 'not evaluated: no travel window configured', sourceIds: [] },
        ],
      })
      const metrics = await gateMetrics(sql, { userId: USER })
      expect(metrics).toHaveLength(GATE_NAMES.length)
      expect(metrics.find((m) => m.gate === 'budget')).toEqual({
        gate: 'budget', passed: 1, failed: 1, notEvaluated: 0,
      })
      // A gate that produced nothing is zero of zero and is still on the card.
      expect(metrics.find((m) => m.gate === 'freshness')).toEqual({
        gate: 'freshness', passed: 0, failed: 0, notEvaluated: 0,
      })
    })
  })

  it('counts production runs and leaves both replays out of the numbers', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const conversationId = c!.id as string
      const [p] = await sql`
        insert into course.proposals (conversation_id, user_id, refs)
        values (${conversationId}, ${USER}, ${sql.json([] as never)})
        returning id`
      const proposalId = p!.id as string
      const write = (proposal: string | null, round: number, passed: boolean) =>
        recordGateResults(sql, {
          conversationId, userId: USER, turnId: null, proposalId: proposal, round,
          results: [passed
            ? { gate: 'budget', passed: true, detail: null, sourceIds: [] }
            : { gate: 'budget', passed: false, detail: 'over', sourceIds: [] }],
        })
      // What production writes: round 0, and no proposal id, because the row it
      // would name does not exist until the gates have already returned.
      await write(null, 0, true)
      // The snapshot replay, which agrees with production, and the live replay,
      // which is wrong on purpose. Counting either would report one proposal's
      // single budget check as two or three.
      await write(proposalId, 1, true)
      await write(proposalId, 2, false)

      const budget = (await gateMetrics(sql, { userId: USER })).find((m) => m.gate === 'budget')!
      expect(budget).toEqual({ gate: 'budget', passed: 1, failed: 0, notEvaluated: 0 })
    })
  })

  it('excludes a production-shaped round that names a proposal, which is the second lock', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const conversationId = c!.id as string
      const [p] = await sql`
        insert into course.proposals (conversation_id, user_id, refs)
        values (${conversationId}, ${USER}, ${sql.json([] as never)})
        returning id`
      // Round 0 AND a proposal id is a shape nothing writes today, because
      // `proposalRunner` records the proposal after the gates return. The
      // predicate refuses it anyway, so a future writer that had an id in hand
      // could not silently double every count on the card.
      await recordGateResults(sql, {
        conversationId, userId: USER, turnId: null, proposalId: p!.id as string, round: 0,
        results: [{ gate: 'slots', passed: true, detail: null, sourceIds: [] }],
      })
      const slots = (await gateMetrics(sql, { userId: USER })).find((m) => m.gate === 'slots')!
      expect(slots).toEqual({ gate: 'slots', passed: 0, failed: 0, notEvaluated: 0 })
    })
  })

  it('surfaces a gate name the table accepts and GATE_NAMES does not', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      // 'reviewer' passes migration 0012's check constraint and is deliberately
      // absent from GATE_NAMES, so `recordGateResults` cannot be asked for it in
      // TypeScript. Written through raw SQL, which is the only way the row can
      // exist, and counted somewhere rather than dropped.
      await sql`
        insert into course.gate_results (conversation_id, user_id, round, gate, passed, detail, source_ids)
        values (${c!.id}, ${USER}, 0, 'reviewer', false, 'a person said no', ${sql.array([] as string[])})`
      const metrics = await gateMetrics(sql, { userId: USER })
      expect(metrics.find((m) => m.gate === OTHER_GATES))
        .toEqual({ gate: OTHER_GATES, passed: 0, failed: 1, notEvaluated: 0 })
      expect(gateRows(metrics).map((r) => r.name)).toContain('gate:other')
    })
  })

  it('leaves the other row off the card entirely when no such row exists', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await recordGateResults(sql, {
        conversationId: c!.id as string, userId: USER, turnId: null, proposalId: null, round: 0,
        results: [{ gate: 'budget', passed: true, detail: null, sourceIds: [] }],
      })
      // A zero for a NAMED gate is a fact about that gate. A zero for a
      // catch-all is a fact about nothing, so it is absent rather than printed.
      const metrics = await gateMetrics(sql, { userId: USER })
      expect(metrics).toHaveLength(GATE_NAMES.length)
      expect(metrics.some((m) => m.gate === OTHER_GATES)).toBe(false)
    })
  })

  it('sums every user id a run used, because a run is several conversations', async () => {
    await withTestDb(async (sql) => {
      // What lesson 6.4's runner produces: one user id per case per repetition,
      // and one number over all of them, because "how often did this gate fire
      // on this run" is a question about the run and not about an id.
      const write = async (userId: string, passed: boolean) => {
        const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
        await recordGateResults(sql, {
          conversationId: c!.id as string, userId, turnId: null, proposalId: null, round: 0,
          results: [passed
            ? { gate: 'budget', passed: true, detail: null, sourceIds: [] }
            : { gate: 'budget', passed: false, detail: 'over', sourceIds: [] }],
        })
      }
      await write(USER, true)
      await write(SECOND_USER, false)
      const both = (await gateMetrics(sql, { userId: [USER, SECOND_USER] })).find((m) => m.gate === 'budget')!
      expect(both).toEqual({ gate: 'budget', passed: 1, failed: 1, notEvaluated: 0 })
      // And one id is still one id, which is what every other case here passes.
      const mine = (await gateMetrics(sql, { userId: USER })).find((m) => m.gate === 'budget')!
      expect(mine).toEqual({ gate: 'budget', passed: 1, failed: 0, notEvaluated: 0 })
    })
  })

  it('keeps a could-not-say out of both sides of the rate', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await recordGateResults(sql, {
        conversationId: c!.id as string, userId: USER, turnId: null, proposalId: null, round: 0,
        results: [{ gate: 'dates', passed: null, detail: 'no window', sourceIds: [] }],
      })
      const rows = gateRows(await gateMetrics(sql, { userId: USER }))
      const dates = rows.find((r) => r.name === 'gate:dates')!
      expect(dates.tally).toEqual({ passed: 0, failed: 0, notEvaluated: 1 })
    })
  })
})
