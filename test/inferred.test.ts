import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { acceptCard } from '../src/channel.js'
import type { TurnState } from '../src/engine.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { inferredFactsFrom, rememberInferred, type Revision } from '../src/loop/inferred.js'
import { emptyNotebook } from '../src/notebook.js'
import { recordProposal } from '../src/repo/proposals.js'
import { recordResults } from '../src/repo/toolResults.js'
import { claimTurn, saveTurnState } from '../src/repo/turns.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import { describeDb, withTestDb } from './helpers/db.js'

const HOTEL_SEARCH = {
  kind: 'hotel' as const, query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

describe('inferred facts from what she changed', () => {
  it('turns each swapped slot into one fact, phrased as an observation and never as a stated preference', () => {
    const revisions: Revision[] = [
      { turnId: 't1', slot: 'stay', instruction: 'somewhere quieter, still near the beach' },
      { turnId: 't2', slot: 'flight', instruction: 'a direct one if there is one' },
    ]
    expect(inferredFactsFrom(revisions)).toEqual([
      'Last time, she asked us to change the stay we picked, so the first stay we '
      + 'propose may not be the one she wants.',
      'Last time, she asked us to change the flight we picked, so the first flight we '
      + 'propose may not be the one she wants.',
    ])
  })

  it('collapses four swaps of one slot into the one fact that slot earns', () => {
    const revisions: Revision[] = Array.from({ length: 4 }, (_, i) => (
      { turnId: `t${i}`, slot: 'stay', instruction: `try again, attempt ${i}` }))
    expect(inferredFactsFrom(revisions)).toHaveLength(1)
    expect(inferredFactsFrom(revisions)[0]).toContain('stay')
  })
})

describe('rememberInferred, best effort and never the reason an accept fails', () => {
  it('returns zero written rather than throwing when the write fails', async () => {
    const throwingSql = (() => { throw new Error('database is down') }) as unknown as postgres.Sql
    await expect(
      rememberInferred(throwingSql, { conversationId: randomUUID(), userId: randomUUID() }),
    ).resolves.toBe(0)
  })
})

/**
 * A conversation with one searched, proposed and undecided stay, whose turn's
 * transcript already carries one `revise_component` call against the `stay`
 * slot: the shape `acceptCard`'s `rememberInferred` reads.
 */
async function proposedStayWithRevision(sql: postgres.Sql, userId: string) {
  const [c] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
  const conversationId = c!.id as string
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${userId}, ${randomUUID()}) returning id`
  const turnId = t!.id as string
  const claim = (await claimTurn(sql, turnId))!
  const items = await mockSuppliers().hotel.search(HOTEL_SEARCH)
  await recordResults(sql, claim, { params: HOTEL_SEARCH, items })
  const state: TurnState = {
    step: 1,
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'toolu_revise', name: 'revise_component',
        input: { proposalId: 'placeholder', slot: 'stay', instruction: 'somewhere quieter' },
      }],
    }],
  }
  await saveTurnState(sql, claim, state)
  const proposalId = await recordProposal(sql, {
    conversationId, userId, turnId,
    refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'stay' }],
    requirementsSnapshot: emptyNotebook(),
  })
  return { conversationId, proposalId, turnId }
}

describeDb('written into her memory by acceptCard', () => {
  it('marks the row inferred=true with a source_turn that resolves, after she accepts', async () => {
    await withTestDb(async (sql) => {
      const userId = randomUUID()
      const { conversationId, proposalId, turnId } = await proposedStayWithRevision(sql, userId)
      const out = await acceptCard(sql, {
        proposalId, conversationId, userId, turnId,
        suppliers: mockSuppliers(), limits: DEFAULT_LIMITS, now: new Date(),
      })
      expect(out.ok).toBe(true)
      const rows = await sql<{ fact: string; inferred: boolean; source_turn: string | null }[]>`
        select fact, inferred, source_turn from course.user_memory where user_id = ${userId}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.inferred).toBe(true)
      expect(rows[0]!.fact).toContain('stay')
      // Resolves: the turn id points at a real row of the traveller's own turns.
      const [turn] = await sql<{ id: string }[]>`
        select id from course.turns where id = ${rows[0]!.source_turn} and user_id = ${userId}`
      expect(turn?.id).toBe(turnId)
    })
  })
})
