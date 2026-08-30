import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { claimTurn, completeTurn, failTurn, FencedError, HEARTBEAT_STALE } from '../src/repo/turns.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()
const EMPTY = { step: 0 }
const deps = (sql: postgres.Sql) => ({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} })

async function seed(sql: postgres.Sql, key: string): Promise<{ conversationId: string; turnId: string }> {
  const submitted = await submitMessage(deps(sql), {
    userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key,
  })
  return { conversationId: submitted.conversationId, turnId: submitted.turnId! }
}

async function silence(sql: postgres.Sql, turnId: string): Promise<void> {
  await sql`update course.turns
               set heartbeat_at = now() - make_interval(secs => ${HEARTBEAT_STALE + 30})
             where id = ${turnId}`
}

describeDb('completeTurn', () => {
  it('writes the reply, the status and the turn spend together', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p1')
      const claim = (await claimTurn(sql, turnId))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 1_250n,
      })

      const [t] = await sql`select status, finished_at, spend_usd_micros from course.turns where id = ${turnId}`
      expect(t!.status).toBe('done')
      expect(t!.finished_at).not.toBeNull()
      expect(BigInt(t!.spend_usd_micros as string)).toBe(1_250n)

      const [c] = await sql`select status, spend_usd_micros from course.conversations where id = ${conversationId}`
      // Parking is TERMINAL for the turn and visible on the conversation: she is
      // the one holding the next move.
      expect(c!.status).toBe('awaiting_user')
      // Conversation spend is ledgerSink's job (lesson 2.6). Adding it here too
      // would double-count it and quietly bypass the daily counter a ceiling reads.
      expect(BigInt(c!.spend_usd_micros as string)).toBe(0n)

      const msgs = await sql`select role, content, turn_id from course.messages
                              where conversation_id = ${conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe('Two options near Faro.')
      expect(msgs[1]!.turn_id).toBe(turnId)
    })
  })

  it('leaves the conversation active when the turn is not parking', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p2')
      const claim = (await claimTurn(sql, turnId))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: null, parked: false, spendMicros: 0n,
      })
      const [c] = await sql`select status from course.conversations where id = ${conversationId}`
      expect(c!.status).toBe('active')
      const msgs = await sql`select id from course.messages where conversation_id = ${conversationId}`
      // A null message writes no row: an empty bubble in her thread reads worse
      // than no reply at all, which is the rule lesson 2.7's closer already had.
      expect(msgs).toHaveLength(1)
    })
  })

  it('refuses to complete when fenced, and changes nothing', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p3')
      const first = (await claimTurn(sql, turnId))!
      await silence(sql, turnId)
      await claimTurn(sql, turnId)

      await expect(completeTurn(sql, first, {
        state: EMPTY, agentMessage: 'stale', parked: true, spendMicros: 99n,
      })).rejects.toThrow(FencedError)

      const msgs = await sql`select role from course.messages where conversation_id = ${conversationId}`
      expect(msgs.map((m) => m.role)).toEqual(['user'])      // she was not answered twice
      const [t] = await sql`select status, spend_usd_micros from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')
      expect(BigInt(t!.spend_usd_micros as string)).toBe(0n)
      const [c] = await sql`select status from course.conversations where id = ${conversationId}`
      expect(c!.status).toBe('working')
    })
  })

  /**
   * The fenced test above throws on the FIRST statement, the fencing update
   * itself, so it cannot tell a real transaction from three statements in a row:
   * an unbatched version passes it too. This forces the failure on a LATER
   * statement instead. The claim is live and correctly fenced, but its userId
   * does not match the conversation's owner, so the turns update (keyed on id,
   * attempts and status only) still matches and sets 'done', and then the
   * messages insert violates the composite foreign key and throws. Only a real
   * transaction rolls the first write back with it.
   */
  it('rolls back an earlier write when a later one fails, leaving the turn running', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p4')
      const claim = (await claimTurn(sql, turnId))!
      const mismatched = { ...claim, userId: randomUUID() }

      await expect(completeTurn(sql, mismatched, {
        state: EMPTY, agentMessage: 'will not survive', parked: true, spendMicros: 500n,
      })).rejects.toThrow()

      const [t] = await sql`select status, spend_usd_micros from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')                       // fails against an unbatched version
      expect(BigInt(t!.spend_usd_micros as string)).toBe(0n)
      const msgs = await sql`select role from course.messages where conversation_id = ${conversationId}`
      expect(msgs.map((m) => m.role)).toEqual(['user'])
      const [c] = await sql`select status from course.conversations where id = ${conversationId}`
      expect(c!.status).toBe('working')
    })
  })
})

describeDb('failTurn', () => {
  it('records the reason and the spend, and surfaces failed on the conversation', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'f1')
      const claim = (await claimTurn(sql, turnId))!
      await failTurn(sql, claim, 'provider_down', 4_200n)

      const [t] = await sql`select status, fail_reason, finished_at, spend_usd_micros
                              from course.turns where id = ${turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('provider_down')
      expect(t!.finished_at).not.toBeNull()
      expect(BigInt(t!.spend_usd_micros as string)).toBe(4_200n)
      const [c] = await sql`select status from course.conversations where id = ${conversationId}`
      expect(c!.status).toBe('failed')
    })
  })

  // Lesson 2.6: tier 2 sets 'limit_reached' on the conversation for exactly this
  // condition hit before the turn was queued. Hitting it one step in must read
  // the same way to her, because a spend ceiling is not "something broke".
  it('surfaces limit_reached, not failed, when the reason is a ceiling', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'f2')
      const claim = (await claimTurn(sql, turnId))!
      await failTurn(sql, claim, 'limit_reached', 0n, LIMIT_REACHED_MESSAGE.daily)

      const [t] = await sql`select fail_reason from course.turns where id = ${turnId}`
      expect(t!.fail_reason).toBe('limit_reached')
      const [c] = await sql`select status from course.conversations where id = ${conversationId}`
      expect(c!.status).toBe('limit_reached')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.daily)
    })
  })

  it('writes no message when there is no sentence for her', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'f3')
      const claim = (await claimTurn(sql, turnId))!
      await failTurn(sql, claim, 'step_cap', 0n)
      const msgs = await sql`select role from course.messages where conversation_id = ${conversationId}`
      expect(msgs.map((m) => m.role)).toEqual(['user'])
    })
  })

  it('refuses to fail when fenced, and changes nothing', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seed(sql, 'f4')
      const first = (await claimTurn(sql, turnId))!
      await silence(sql, turnId)
      await claimTurn(sql, turnId)

      await expect(failTurn(sql, first, 'provider_down', 0n)).rejects.toThrow(FencedError)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')
      expect(t!.fail_reason).toBeNull()
    })
  })
})
