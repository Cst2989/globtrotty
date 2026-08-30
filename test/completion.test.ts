import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { claimTurn, completeTurn, failTurn, FencedError, HEARTBEAT_STALE } from '../src/repo/turns.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps, silentFor } from './helpers/turns.js'

const USER = randomUUID()
const EMPTY = { step: 0, messages: [] }

async function seed(sql: postgres.Sql, key: string): Promise<{ conversationId: string; turnId: string }> {
  const submitted = await submitMessage(handlerDeps(sql), {
    userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key,
  })
  return { conversationId: submitted.conversationId, turnId: submitted.turnId! }
}

describeDb('completeTurn', () => {
  it('writes the reply, the status and the turn spend together', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p1')
      const claim = (await claimTurn(sql, turnId))!
      await completeTurn(sql, claim, {
        state: { step: 3, messages: [] }, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 1_250n,
      })

      const [t] = await sql`select status, finished_at, spend_usd_micros, state from course.turns where id = ${turnId}`
      expect(t!.status).toBe('done')
      expect(t!.finished_at).not.toBeNull()
      expect(BigInt(t!.spend_usd_micros as string)).toBe(1_250n)
      // A non-zero step, so this cannot pass on state's own default: a
      // regression that dropped state from the SET list would still pass with
      // { step: 0 }.
      expect(t!.state).toEqual({ step: 3, messages: [] })

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

      // Terminal means the slot is free: her next message opens a new turn
      // rather than bouncing off the one-live-turn index as 'busy'.
      const next = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId, message: 'and the crib?', idempotencyKey: 'p1-next',
      })
      expect(next.status).toBe('queued')
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
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
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
   * an unbatched version passes it too. This forces the failure onto the LAST
   * statement instead, the conversation update. The claim is live and correctly
   * fenced, but its userId does not match the conversation's owner, so the
   * turns update (keyed on id, attempts and status only) still matches and sets
   * 'done'. `agentMessage: null` skips the messages insert on purpose: with a
   * message present the composite foreign key on that insert would throw first,
   * and this test would pass without ever reaching the conversation update it
   * means to exercise, which is exactly what happened before that update
   * checked its own row count. Now the conversation update itself matches zero
   * rows and throws. Only a real transaction rolls the turns write back with it.
   */
  it('rolls back an earlier write when a later one fails, leaving the turn running', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seed(sql, 'p4')
      const claim = (await claimTurn(sql, turnId))!
      const mismatched = { ...claim, userId: randomUUID() }

      await expect(completeTurn(sql, mismatched, {
        state: EMPTY, agentMessage: null, parked: true, spendMicros: 500n,
      })).rejects.toThrow('completeTurn: conversation not found (fail closed)')

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
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      await claimTurn(sql, turnId)

      await expect(failTurn(sql, first, 'provider_down', 0n)).rejects.toThrow(FencedError)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${turnId}`
      expect(t!.status).toBe('running')
      expect(t!.fail_reason).toBeNull()
    })
  })
})
