import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { bookingUrl } from '../src/cashier.js'
import { MIN_OBSERVATIONS } from '../src/loop/derive.js'
import { EXAMPLES_PER_PROMPT, renderExamples, selectExamples } from '../src/loop/examples.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { recordConversion } from '../src/repo/conversions.js'
import { recordLinkClicks } from '../src/repo/linkClicks.js'
import { decideProposal, recordProposal } from '../src/repo/proposals.js'
import { describeDb, withRealDb } from './helpers/db.js'

const stated = <T>(value: T) => ({ value, source: 'user' as const, at: '2026-09-14T10:00:00Z' })

/** The three slots a booking in this file may fill, in the order a proposal grows. */
const COMPONENTS = [
  { sourceId: 'mock-flight-1', quantity: 1, slot: 'flight' },
  { sourceId: 'mock-hotel-1', quantity: 1, slot: 'stay' },
  { sourceId: 'mock-transfer-1', quantity: 1, slot: 'transfer' },
]

/**
 * A conversation, a proposal she accepted as proposed, and one link click and
 * one conversion per component, reusing `recordProposal`, `recordLinkClicks` and
 * `recordConversion` the way lesson 7.3's own database case does.
 *
 * Written out in full here rather than imported from test/similarity.test.ts:
 * `test/regressions.test.ts` pins cross-test imports, and a shared fixture
 * builder between two test files is a seam with no owner.
 */
async function bookedProposal(
  sql: postgres.Sql, userId: string,
  args: { nights: number; children: number; components: number },
): Promise<string> {
  const [conversation] = await sql<{ id: string }[]>`
    insert into course.conversations (user_id) values (${userId}) returning id`
  const refs = COMPONENTS.slice(0, args.components)
  const snapshot: Notebook = {
    ...emptyNotebook(),
    nights: stated(args.nights),
    partySize: stated({ adults: 2, children: args.children, infants: 0 }),
  }
  const proposalId = await recordProposal(sql, {
    conversationId: conversation!.id, userId, turnId: null,
    refs, requirementsSnapshot: snapshot,
  })
  await decideProposal(sql, {
    proposalId, conversationId: conversation!.id, decision: 'accept',
  })
  const trackingRefs = refs.map(() => randomUUID())
  await recordLinkClicks(sql, {
    proposalId, turnId: null, userId, verified: true, quotedAt: new Date(),
    links: refs.map((r, i) => ({
      id: trackingRefs[i]!, sourceId: r.sourceId, supplier: 'mock', trackingRef: trackingRefs[i]!,
      url: bookingUrl('mock', r.sourceId, trackingRefs[i]!), quoted: money(40_000n, 'EUR'),
    })),
  })
  for (const ref of trackingRefs) {
    await recordConversion(sql, {
      trackingRef: ref, supplier: 'mock', bookedAt: new Date('2026-09-20T00:00:00Z'),
      amountMinor: 40_000n, currency: 'EUR', commissionMinor: 2_800n, reportedAt: new Date(),
    })
  }
  return proposalId
}

describeDb('selection, within a difficulty', () => {
  it('returns nothing for a segment below the observation threshold', async () => {
    await withRealDb(async (sql, userId) => {
      await bookedProposal(sql, userId, { nights: 3, children: 0, components: 1 })
      // One booking is not a ranking. The desk gets no examples rather than one
      // chosen by noise, which is lesson 7.2's guard applied to the segment and
      // not to the traveller.
      expect(await selectExamples(sql, { userId, difficulty: 'simple' })).toEqual([])
    })
  })

  it('ranks the hard trip first inside its own segment', async () => {
    await withRealDb(async (sql, userId) => {
      for (let i = 0; i < MIN_OBSERVATIONS; i += 1) {
        await bookedProposal(sql, userId, { nights: 3, children: 0, components: 1 })
        await bookedProposal(sql, userId, { nights: 3, children: 1, components: 3 })
      }
      const complex = await selectExamples(sql, { userId, difficulty: 'complex' })
      const simple = await selectExamples(sql, { userId, difficulty: 'simple' })
      // The trips the unsegmented ranking suppressed are now the examples the
      // desk sees for hard requests, and the easy ones are still the examples
      // for easy requests. Nothing was thrown away and no score was adjusted.
      expect(complex).toHaveLength(EXAMPLES_PER_PROMPT)
      expect(complex.every((e) => e.difficulty === 'complex')).toBe(true)
      expect(simple.every((e) => e.difficulty === 'simple')).toBe(true)
    })
  })

  it('carries the rows behind every example into the rendered file', async () => {
    await withRealDb(async (sql, userId) => {
      for (let i = 0; i < MIN_OBSERVATIONS; i += 1) {
        await bookedProposal(sql, userId, { nights: 3, children: 1, components: 3 })
      }
      const examples = await selectExamples(sql, { userId, difficulty: 'complex' })
      const file = renderExamples([{ difficulty: 'complex', examples }], '2026-09-14T10:00:00Z')
      for (const example of examples) expect(file).toContain(example.proposalId)
      // And the provenance is inside a comment, so it never reaches the model.
      expect(file.indexOf(examples[0]!.proposalId)).toBeLessThan(file.indexOf('-->'))
    })
  })
})
