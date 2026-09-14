import { randomUUID } from 'node:crypto'
import { renderWorst, WORST_RULE, worstConversations } from '../src/loop/worst.js'
import { describeDb, withRealDb } from './helpers/db.js'

/** One conversation, with the rows worstConversations scores it on. */
async function conversation(
  sql: Parameters<typeof worstConversations>[0], userId: string,
  args: { rejections?: number; capped?: number; status?: string } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into course.conversations (user_id, status)
    values (${userId}, ${args.status ?? 'active'})
    returning id`
  const conversationId = row!.id
  for (let i = 0; i < (args.rejections ?? 0); i += 1) {
    await sql`
      insert into course.proposals
        (conversation_id, user_id, refs, requirements_snapshot, decision, decided_at)
      values (${conversationId}, ${userId}, ${sql.json([] as never)}, ${sql.json({} as never)},
              'reject', now())`
  }
  for (let i = 0; i < (args.capped ?? 0); i += 1) {
    await sql`
      insert into course.turns (conversation_id, user_id, idempotency_key, status, fail_reason)
      values (${conversationId}, ${userId}, ${randomUUID()}, 'failed', 'limit_reached')`
  }
  return conversationId
}

describe('renderWorst', () => {
  it('prints nothing to read, and the rule, when there is nothing', () => {
    expect(renderWorst([])).toBe(`nothing to read this week\n\n${WORST_RULE}`)
  })

  it('prints a scored line per row', () => {
    const out = renderWorst([{
      conversationId: 'abc', status: 'failed', rejected: 2, capped: 1, escalated: true, score: 4,
    }])
    expect(out).toContain('the 1 worst conversations')
    expect(out).toContain('abc')
    expect(out).toContain('score 4')
    expect(out).toContain('2 rejected, 1 capped, escalated')
  })
})

describeDb('worstConversations', () => {
  it('orders a conversation with two rejections above one with one, and drops a clean one', async () => {
    await withRealDb(async (sql, userId) => {
      const worse = await conversation(sql, userId, { rejections: 2 })
      const better = await conversation(sql, userId, { rejections: 1 })
      const clean = await conversation(sql, userId)
      const rows = await worstConversations(sql, { limit: 1000 })
      const ids = rows.map((r) => r.conversationId)
      expect(ids.indexOf(worse)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(better)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(worse)).toBeLessThan(ids.indexOf(better))
      expect(ids).not.toContain(clean)
      const worseRow = rows.find((r) => r.conversationId === worse)!
      expect(worseRow.score).toBe(2)
      expect(worseRow.rejected).toBe(2)
    })
  })

  it('counts a capped turn and an escalated status into the score', async () => {
    await withRealDb(async (sql, userId) => {
      const id = await conversation(sql, userId, { capped: 1, status: 'escalated' })
      const rows = await worstConversations(sql, { limit: 1000 })
      const row = rows.find((r) => r.conversationId === id)!
      expect(row.capped).toBe(1)
      expect(row.escalated).toBe(true)
      expect(row.score).toBe(2)
    })
  })

  it('breaks a tie on the conversation id, not on created_at', async () => {
    await withRealDb(async (sql, userId) => {
      const a = await conversation(sql, userId, { rejections: 1 })
      const b = await conversation(sql, userId, { rejections: 1 })
      const [lower, higher] = [a, b].sort() as [string, string]
      const rows = await worstConversations(sql, { limit: 1000 })
      const ids = rows.map((r) => r.conversationId)
      // Both share a score of 1. Every row this test wrote that ties with these
      // two also has a userId of its own, so between `lower` and `higher`
      // nothing else this suite could have written shares their exact score AND
      // sits lexicographically between their ids: the ordering asserted here is
      // the two of them against each other.
      expect(ids.indexOf(lower)).toBeLessThan(ids.indexOf(higher))
    })
  })
})
