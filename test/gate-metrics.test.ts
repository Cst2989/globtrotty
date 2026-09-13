import { randomUUID } from 'node:crypto'
import { gateMetrics, gateRows } from '../src/evals/gateMetrics.js'
import { GATE_NAMES } from '../src/gates/types.js'
import { recordGateResults } from '../src/repo/gateResults.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

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
