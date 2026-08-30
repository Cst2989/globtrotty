import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { money } from '../src/money.js'
import { submitMessage } from '../src/handler.js'
import { recordLinkClicks } from '../src/repo/linkClicks.js'
import { recordProposal } from '../src/repo/proposals.js'
import { MAX_ATTEMPTS } from '../src/repo/turns.js'
import { sweep } from '../src/sweeper.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withRealDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'
import { workerDeps } from './helpers/worker.js'

const USER = randomUUID()

/** A turn with a proposal and one emitted link, which is the state rule 6 is about. */
async function turnWithALink(
  sql: postgres.Sql, userId: string, key: string,
  over: { verified?: boolean; quotedAt?: Date } = {},
) {
  const submitted = await submitMessage(handlerDeps(sql), {
    userId, conversationId: null, message: 'book it', idempotencyKey: key,
  })
  const turnId = submitted.turnId!
  const proposalId = await recordProposal(sql, {
    conversationId: submitted.conversationId, userId, turnId,
    refs: [{ sourceId: 'hotel-0-1', quantity: 1, slot: 'stay' }],
  })
  const id = randomUUID()
  await recordLinkClicks(sql, {
    proposalId, turnId, userId,
    verified: over.verified ?? true,
    quotedAt: over.quotedAt ?? new Date(),
    links: [{ id, sourceId: 'hotel-0-1', supplier: 'mock', trackingRef: id,
              url: `https://example.invalid/book/hotel-0-1?subid=${id}`, quoted: money(72_100n, 'EUR') }],
  })
  return { ...submitted, turnId, proposalId }
}

describeDb('after a link is emitted, the worker', () => {
  it('completes the turn with the link message instead of failing it', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-1')
      // An agent that emits and then dies, which is the whole case: the links
      // are already out and the process is not going to finish the turn
      // normally.
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      // runTurn still re-throws, exactly as it does on every other error: the
      // change is what it WRITES before it does, not whether it propagates.
      // Tier 3's own catch is what turns this into a 200 (see
      // netlify/functions/run-turn-background.mts).
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId))
        .rejects.toThrow(/killed after emitting/)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      // Not 'failed'. She is on a supplier's checkout page and a system that
      // tells her the request failed is describing a world she is not in.
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBeNull()

      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent' order by seq`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toContain('example.invalid/book/hotel-0-1')
      expect(msgs[0]!.content).not.toBe(TURN_FAILED_MESSAGE)
    })
  })

  it('still fails a turn that emitted nothing', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'plan it', idempotencyKey: 'ponr-2',
      })
      const dying: Agent = async () => { throw new Error('killed before emitting') }
      // The pre-existing behaviour, unchanged, and worth pinning here: the new
      // branch must be reachable ONLY through a link_clicks row.
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId!)).rejects.toThrow(/killed/)
      const [t] = await sql`select status from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs[0]!.content).toBe(TURN_FAILED_MESSAGE)
    })
  })

  it('states the price\'s real age, from the row, and not "just now"', async () => {
    await withTestDb(async (sql) => {
      // An unverified hand-off: the copy is disclosure, so it renders the age,
      // and the age is the one thing the recovery cannot recompute. Reading it
      // off course.link_clicks.quoted_at is why that column exists.
      const submitted = await turnWithALink(sql, USER, 'ponr-5', {
        verified: false, quotedAt: new Date(Date.now() - 4 * 3_600_000),
      })
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId))
        .rejects.toThrow(/killed after emitting/)

      const [m] = await sql`select content from course.messages
                             where turn_id = ${submitted.turnId} and role = 'agent'`
      // Telling her a four-hour-old price was current is the same untrue
      // reassurance the naive re-quote gives, arrived at from the other end.
      expect(m!.content).toContain('4 hours ago')
      expect(m!.content).not.toContain('just now')
    })
  })
})

describeDb('after a link is emitted, the sweeper', () => {
  it('does not tell her the request failed', async () => {
    await withRealDb(async (sql, userId) => {
      const submitted = await turnWithALink(sql, userId, 'ponr-3')
      // Out of attempts and silent: the crash-loop arm's exact condition.
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'running',
                       heartbeat_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      const result = await sweep(sql)
      expect(result.reaped).toContain(submitted.turnId)

      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      // No TURN_FAILED_MESSAGE. The sweeper cannot rebuild the link sentence in
      // SQL and it will not write one that contradicts it, so it writes
      // nothing; the conversation goes back to awaiting_user rather than
      // failed, and the rows are in course.link_clicks for an operator.
      expect(msgs).toHaveLength(0)
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('awaiting_user')
    })
  })

  it('still tells her when a crash-looped turn emitted nothing', async () => {
    await withRealDb(async (sql, userId) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId, conversationId: null, message: 'plan it', idempotencyKey: 'ponr-4',
      })
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'running',
                       heartbeat_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      await sweep(sql)
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs[0]!.content).toBe(TURN_FAILED_MESSAGE)
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('failed')
    })
  })
})
