import { randomUUID } from 'node:crypto'
import {
  assertComparableShape, bookedSetsFor, similarity, survivalScores,
  GOLDEN_UNCHANGED_FLOOR, ShapeMismatchError, type BookedSet,
} from '../src/loop/similarity.js'
import { valueOr } from '../src/loop/derive.js'
import { REFS_SCHEMA_VERSION, recordProposal } from '../src/repo/proposals.js'
import { recordConversion } from '../src/repo/conversions.js'
import { recordLinkClicks } from '../src/repo/linkClicks.js'
import { bookingUrl } from '../src/cashier.js'
import { money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import { describeDb, withRealDb } from './helpers/db.js'

const WIDE = [
  { sourceId: 'mock-flight-1', quantity: 1, slot: 'flight' },
  { sourceId: 'mock-hotel-1', quantity: 1, slot: 'stay' },
  { sourceId: 'mock-transfer-1', quantity: 1, slot: 'transfer' },
]
const booked = (ids: string[]): BookedSet => ({ proposalId: 'p-1', itemIds: new Set(ids) })

describe('survival, against the shape this branch writes', () => {
  it('scores a proposal she booked unchanged above the golden floor', () => {
    const score = similarity(
      { id: 'p-1', refs: WIDE, refsSchemaVersion: REFS_SCHEMA_VERSION },
      booked(WIDE.map((r) => r.sourceId)))
    expect(valueOr(score, 0)).toBeGreaterThan(GOLDEN_UNCHANGED_FLOOR)
    // Defence two: the number says which row it came from.
    expect(score.sourceProposalIds).toEqual(['p-1'])
  })

  it('scores a proposal she replaced outright near zero', () => {
    const score = similarity(
      { id: 'p-1', refs: WIDE, refsSchemaVersion: REFS_SCHEMA_VERSION },
      booked(['mock-flight-9', 'mock-hotel-9', 'mock-transfer-9']))
    expect(valueOr(score, 1)).toBe(0)
  })

  it('refuses a row written at a shape this comparison was not written for', () => {
    // The refactor, as the tree would actually carry it: the writer bumps the
    // stamp and this reader has not been updated. The inversion bug's first row
    // is now a throw that names both numbers instead of a 0.33 nobody sees.
    expect(() => similarity(
      { id: 'p-1', refs: WIDE.slice(0, 1), refsSchemaVersion: REFS_SCHEMA_VERSION + 1 },
      booked(WIDE.map((r) => r.sourceId)))).toThrow(ShapeMismatchError)
  })

  it('refuses a row whose refs lost a field, even when the stamp did not move', () => {
    // The refactor that actually happens: the shape changed and nobody
    // remembered the version. This is why the stamp check and the field check
    // are two checks.
    expect(() => assertComparableShape({
      id: 'p-1',
      refs: [{ sourceId: 'mock-flight-1', quantity: 1 } as never],
      refsSchemaVersion: REFS_SCHEMA_VERSION,
    })).toThrow(/without a sourceId and a slot/)
  })
})

describeDb('survival over real rows', () => {
  it('scores a proposal she booked unchanged above the floor, end to end', async () => {
    await withRealDb(async (sql, userId) => {
      const [conversation] = await sql<{ id: string }[]>`
        insert into course.conversations (user_id) values (${userId}) returning id`
      const proposalId = await recordProposal(sql, {
        conversationId: conversation!.id, userId, turnId: null,
        refs: WIDE, requirementsSnapshot: emptyNotebook(),
      })
      const refs = WIDE.map(() => randomUUID())
      await recordLinkClicks(sql, {
        proposalId, turnId: null, userId, verified: true, quotedAt: new Date(),
        links: WIDE.map((r, i) => ({
          id: refs[i]!, sourceId: r.sourceId, supplier: 'mock', trackingRef: refs[i]!,
          url: bookingUrl('mock', r.sourceId, refs[i]!), quoted: money(40_000n, 'EUR'),
        })),
      })
      for (const ref of refs) {
        await recordConversion(sql, {
          trackingRef: ref, supplier: 'mock', bookedAt: new Date('2026-09-20T00:00:00Z'),
          amountMinor: 40_000n, currency: 'EUR', commissionMinor: 2_800n, reportedAt: new Date(),
        })
      }
      expect(await bookedSetsFor(sql, { userId })).toHaveLength(1)
      const scores = await survivalScores(sql, { userId })
      expect(valueOr(scores.get(proposalId)!, 0)).toBeGreaterThan(GOLDEN_UNCHANGED_FLOOR)
    })
  })
})
