import { randomUUID } from 'node:crypto'
import {
  acceptanceObservations, deriveScore, valueOr,
  MIN_OBSERVATIONS, RECENCY_WINDOW, type DerivedScore, type Observation,
} from '../src/loop/derive.js'
import { decideProposal, recordProposal } from '../src/repo/proposals.js'
import { emptyNotebook } from '../src/notebook.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

const at = (day: number): Date => new Date(`2026-09-${String(day).padStart(2, '0')}T10:00:00Z`)
const obs = (n: number, value: number): Observation[] =>
  Array.from({ length: n }, (_, i) => ({ proposalId: `p-${i}`, decidedAt: at(i + 1), value }))

describe('a derived score', () => {
  it('abstains on zero observations instead of scoring zero', () => {
    const score = deriveScore([])
    expect(score.basis).toBe('none')
    expect(score.sourceProposalIds).toEqual([])
    // The assertion the first version of this file could not make: an absent
    // measurement and a measured zero are now different values, and nothing
    // downstream can confuse them by accident.
    const measuredZero = deriveScore(obs(MIN_OBSERVATIONS, 0))
    expect(measuredZero.basis).toBe('learned')
    expect(score).not.toEqual(measuredZero)
  })

  it('does not let a caller read a value off an absent score', () => {
    const score: DerivedScore = deriveScore([])
    // @ts-expect-error a score derived from nothing has no value to read
    const accidental = score.value
    expect(accidental).toBeUndefined()
    // The explicit door, which a reader of the call site can argue with.
    expect(valueOr(score, 0.5)).toBe(0.5)
  })

  it('falls back to recency below the threshold, and says that is what it did', () => {
    const score = deriveScore(obs(MIN_OBSERVATIONS - 1, 1))
    expect(score.basis).toBe('recency')
    // Three rows and not four, because the fallback is a hint and not a ranking.
    expect(score.sourceProposalIds).toHaveLength(RECENCY_WINDOW)
  })

  it('learns at the threshold, and carries every row that produced it', () => {
    const score = deriveScore([...obs(MIN_OBSERVATIONS - 1, 1), ...obs(1, 0)])
    expect(score.basis).toBe('learned')
    expect(score.sourceProposalIds).toHaveLength(MIN_OBSERVATIONS)
    expect(valueOr(score, 0)).toBeCloseTo((MIN_OBSERVATIONS - 1) / MIN_OBSERVATIONS)
  })

  it('takes the newest rows for the fallback whatever order it was handed', () => {
    const shuffled = [
      { proposalId: 'old', decidedAt: at(1), value: 0 },
      { proposalId: 'new', decidedAt: at(20), value: 1 },
      { proposalId: 'mid', decidedAt: at(10), value: 1 },
      { proposalId: 'older', decidedAt: at(2), value: 0 },
    ]
    expect(deriveScore(shuffled).sourceProposalIds).toEqual(['new', 'mid', 'older'])
  })
})

describeDb('her acceptance rate on day one and on day six', () => {
  it('abstains, then falls back, then learns, off real rows', async () => {
    await withTestDb(async (sql) => {
      const [conversation] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${USER}) returning id`
      expect(deriveScore(await acceptanceObservations(sql, { userId: USER })).basis).toBe('none')
      const ids: string[] = []
      for (let i = 0; i < MIN_OBSERVATIONS; i += 1) {
        const id = await recordProposal(sql, {
          conversationId: conversation!.id, userId: USER, turnId: null,
          refs: [{ sourceId: `mock-hotel-${i}`, quantity: 1, slot: 'stay' }],
          requirementsSnapshot: emptyNotebook(),
        })
        ids.push(id)
        await decideProposal(sql, {
          proposalId: id, conversationId: conversation!.id,
          decision: i === 0 ? 'reject' : 'accept', at: at(i + 1),
        })
        const score = deriveScore(await acceptanceObservations(sql, { userId: USER }))
        expect(score.basis).toBe(i + 1 >= MIN_OBSERVATIONS ? 'learned' : 'recency')
      }
      const learned = deriveScore(await acceptanceObservations(sql, { userId: USER }))
      // Every row that produced the number, by id, which is the requirement.
      expect([...learned.sourceProposalIds].sort()).toEqual([...ids].sort())
    })
  })
})
