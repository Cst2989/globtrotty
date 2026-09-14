import { randomUUID } from 'node:crypto'
import {
  conversionsFor, normalizeTrackingRef, recordConversion, UnattributableConversionError,
} from '../src/repo/conversions.js'
import { recordLinkClicks } from '../src/repo/linkClicks.js'
import { bookingUrl } from '../src/cashier.js'
import { money } from '../src/money.js'
import { describeDb, withRealDb } from './helpers/db.js'

const REF = randomUUID()

/** One accepted proposal with one emitted link, which is the state a conversion arrives into. */
async function emittedLink(
  sql: Parameters<typeof recordLinkClicks>[0], userId: string,
): Promise<{ conversationId: string; proposalId: string }> {
  const [conversation] = await sql<{ id: string }[]>`
    insert into course.conversations (user_id) values (${userId}) returning id`
  const [proposal] = await sql<{ id: string }[]>`
    insert into course.proposals (conversation_id, user_id, refs, requirements_snapshot)
    values (${conversation!.id}, ${userId},
            ${sql.json([{ sourceId: 'mock-hotel-1', quantity: 1, slot: 'stay' }] as never)},
            ${sql.json({} as never)})
    returning id`
  await recordLinkClicks(sql, {
    proposalId: proposal!.id, turnId: null, userId, verified: true, quotedAt: new Date(),
    links: [{
      id: REF, sourceId: 'mock-hotel-1', supplier: 'mock', trackingRef: REF,
      url: bookingUrl('mock', 'mock-hotel-1', REF), quoted: money(120_000n, 'EUR'),
    }],
  })
  return { conversationId: conversation!.id, proposalId: proposal!.id }
}

describe('a ref a network mangled', () => {
  it('survives a lowercasing and a trim', () => {
    expect(normalizeTrackingRef(`  ${REF.toUpperCase()}  `)).toBe(REF)
  })

  it('does not survive a truncation, and is not resolved by prefix', () => {
    expect(normalizeTrackingRef(REF.slice(0, 30))).toBeNull()
  })
})

describeDb('a conversion reported against a link we emitted', () => {
  it('is refused when the ref was truncated, before any query runs', async () => {
    await withRealDb(async (sql, userId) => {
      await emittedLink(sql, userId)
      await expect(recordConversion(sql, {
        trackingRef: REF.slice(0, 30), supplier: 'mock', bookedAt: new Date(),
        amountMinor: 118_000n, currency: 'EUR', commissionMinor: 8_260n, reportedAt: new Date(),
      })).rejects.toThrow(UnattributableConversionError)
    })
  })

  it('is refused when no link carries the ref, and says which fault it was', async () => {
    await withRealDb(async (sql) => {
      await expect(recordConversion(sql, {
        trackingRef: randomUUID(), supplier: 'mock', bookedAt: new Date(),
        amountMinor: 118_000n, currency: 'EUR', commissionMinor: 8_260n, reportedAt: new Date(),
      })).rejects.toThrow(/no link we emitted carries that ref/)
    })
  })

  it('is refused when the reported supplier is not the one we sent her to', async () => {
    await withRealDb(async (sql, userId) => {
      await emittedLink(sql, userId)
      await expect(recordConversion(sql, {
        trackingRef: REF, supplier: 'kiwi', bookedAt: new Date(),
        amountMinor: 118_000n, currency: 'EUR', commissionMinor: 8_260n, reportedAt: new Date(),
      })).rejects.toThrow(/we sent her to mock and the report names kiwi/)
    })
  })

  it('joins, and takes both ids off the click rather than off the feed', async () => {
    await withRealDb(async (sql, userId) => {
      const { conversationId, proposalId } = await emittedLink(sql, userId)
      await recordConversion(sql, {
        trackingRef: REF.toUpperCase(), supplier: 'mock', bookedAt: new Date('2026-09-20T00:00:00Z'),
        amountMinor: 118_000n, currency: 'EUR', commissionMinor: 8_260n,
        reportedAt: new Date('2026-11-02T00:00:00Z'),
      })
      const [row] = await conversionsFor(sql, { userId })
      expect(row!.conversationId).toBe(conversationId)
      expect(row!.proposalId).toBe(proposalId)
      // The number we told her, beside the number the network reported. She was
      // quoted 1,200.00 EUR and booked at 1,180.00, which is a real gap this
      // table can now see and nothing on this branch could see before it.
      expect(row!.quoted).toEqual(money(120_000n, 'EUR'))
      expect(row!.amount).toEqual(money(118_000n, 'EUR'))
      expect(row!.commission).toEqual(money(8_260n, 'EUR'))
    })
  })

  it('is reported twice by a network and stored once', async () => {
    await withRealDb(async (sql, userId) => {
      await emittedLink(sql, userId)
      const reported = {
        trackingRef: REF, supplier: 'mock', bookedAt: new Date('2026-09-20T00:00:00Z'),
        amountMinor: 118_000n, currency: 'EUR', commissionMinor: 8_260n, reportedAt: new Date(),
      }
      await recordConversion(sql, reported)
      // A duplicate report is common and is not a second booking. The unique
      // constraint on tracking_ref is what makes the second write impossible
      // rather than idempotent, so every rate derived from this table has a
      // denominator of trips and not of emails.
      await expect(recordConversion(sql, reported)).rejects.toThrow()
      const rows = await conversionsFor(sql, { userId })
      expect(rows).toHaveLength(1)
    })
  })
})
