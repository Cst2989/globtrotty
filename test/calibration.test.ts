import { randomUUID } from 'node:crypto'
import {
  agreementSeries, conversionByPromptVersion, type DatedLabelled,
} from '../src/loop/calibration.js'
import { describeDb, withTestDb } from './helpers/db.js'

describe('the calibration series, monthly over her decisions', () => {
  it('leaves a month with no rows absent from the series, rather than present at zero', () => {
    const rows: DatedLabelled[] = [
      { proposalId: 'a', decision: 'accept', verdict: 'pass', decidedAt: new Date('2026-01-15T00:00:00Z') },
      { proposalId: 'b', decision: 'accept', verdict: 'pass', decidedAt: new Date('2026-03-10T00:00:00Z') },
    ]
    // No row here is silence, not a calibration that ran and found nothing:
    // February never appears, rather than appearing at 0/0.
    expect(agreementSeries(rows).map((p) => p.month)).toEqual(['2026-01', '2026-03'])
  })

  it('reports a month below the floor as meetsFloor false, with its real denominator', () => {
    const rows: DatedLabelled[] = Array.from({ length: 10 }, (_, i) => ({
      proposalId: `p${i}`,
      decision: 'accept' as const,
      verdict: i < 7 ? 'pass' as const : 'fail' as const,
      decidedAt: new Date('2026-02-05T00:00:00Z'),
    }))
    const [point] = agreementSeries(rows)
    expect(point!.month).toBe('2026-02')
    expect(point!.agreement).toEqual({ agreed: 7, total: 10, meetsFloor: false })
  })

  it('orders the series oldest first, regardless of the order the rows arrived in', () => {
    const rows: DatedLabelled[] = [
      { proposalId: 'c', decision: 'accept', verdict: 'pass', decidedAt: new Date('2026-03-01T00:00:00Z') },
      { proposalId: 'a', decision: 'accept', verdict: 'pass', decidedAt: new Date('2026-01-01T00:00:00Z') },
      { proposalId: 'b', decision: 'accept', verdict: 'pass', decidedAt: new Date('2026-02-01T00:00:00Z') },
    ]
    expect(agreementSeries(rows).map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })
})

describeDb('the release canary\'s verdict, joined through the turn', () => {
  it('returns a row per prompt version with zero conversions, rather than no row at all', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const [conversation] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const [turn] = await sql<{ id: string }[]>`
        insert into course.turns (conversation_id, user_id, idempotency_key)
        values (${conversation!.id}, ${userId}, ${randomUUID()}) returning id`
      await sql`
        insert into course.model_calls (conversation_id, user_id, turn_id, seat, prompt_version,
                                        model_requested, model_returned)
        values (${conversation!.id}, ${userId}, ${turn!.id}, 'driver', 'v1',
                'claude-opus-5', 'claude-opus-5')`
      await sql`
        insert into course.proposals (conversation_id, user_id, turn_id, refs, requirements_snapshot)
        values (${conversation!.id}, ${userId}, ${turn!.id},
                ${sql.json([{ sourceId: 'mock-hotel-1', quantity: 1, slot: 'stay' }] as never)},
                ${sql.json({} as never)})`
      // No link_clicks and no conversions row for this proposal: the LEFT
      // JOINs on both must not drop the arm, or a rate that fails silently
      // improves every time a booking never comes back.
      const rows = await conversionByPromptVersion(sql, { userId })
      expect(rows).toEqual([{ promptVersion: 'v1', proposals: 1, conversions: 0 }])
    })
  })
})
