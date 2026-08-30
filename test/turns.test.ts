import { randomUUID } from 'node:crypto'
import { newConversation, turn } from '../src/conversation.js'
import { isFailReason } from '../src/engine.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { claimTurn, completeTurn, failTurn, loadTurnInput } from '../src/repo/turns.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { fakeClient, textMessage } from './model/fake.js'

const USER = randomUUID()

describeDb('loadTurnInput', () => {
  it('returns the message the turn was queued for', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'turns-1',
      })
      // the queued path always names a turn; only limit_reached returns null
      const input = await loadTurnInput(sql, submitted.turnId!)
      expect(input?.message).toBe('a week in Portugal')
      expect(input?.conversationId).toBe(submitted.conversationId)
    })
  })

  it('returns null for a turn that has already run', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-2',
      })
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await completeTurn(sql, claim, {
        state: { step: 0 }, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 0n,
      })
      expect(await loadTurnInput(sql, submitted.turnId!)).toBeNull()
    })
  })

  // The reason the join is on the turn id and not on the conversation.
  it('ignores a later message on the same conversation', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'turns-3',
      })
      // She types again while the turn is still queued. Lesson 2.7 makes this
      // the 'busy' path; today it is just another row with no turn of its own.
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${submitted.conversationId}, ${USER}, null, 'user', 'and I forgot the crib')`
      const input = await loadTurnInput(sql, submitted.turnId!)
      expect(input?.message).toBe('a week in Portugal')
    })
  })
})

describeDb('completeTurn, through the path tier 3 takes', () => {
  it('writes the reply and closes the turn together', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, invoke: async () => {}, limits: DEFAULT_LIMITS },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-4' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await completeTurn(sql, claim, {
        state: { step: 1 }, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 0n,
      })
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe('Two options near Faro.')
      const [t] = await sql`select status, finished_at from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.finished_at).not.toBeNull()
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('awaiting_user')
    })
  })

  it('records the same limit_reached reason tier 2 does, with the same sentence', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, invoke: async () => {}, limits: DEFAULT_LIMITS },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-5' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await failTurn(sql, claim, 'limit_reached', 0n, LIMIT_REACHED_MESSAGE.conversation)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('limit_reached')
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('limit_reached')
      const msgs = await sql`select content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.conversation)
    })
  })

  // The whole tier-3 path, with the fake client standing in for the model: a
  // capped turn ends with her sentence on the row and the reason beside it.
  it('writes the exact capped sentence and fail_reason through the real tier-3 path', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, invoke: async () => {}, limits: DEFAULT_LIMITS },
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-6' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      const result = await turn(
        newConversation(input.conversationId), input.message,
        fakeClient([textMessage('never reached')]), mockRunner(new MockSupplier()),
        {
          readSpend: async () => ({
            conversationMicros: DEFAULT_LIMITS.conversationCeilingMicros,
            dailyMicros: 0n, globalMicros: 0n,
          }),
        },
      )
      expect(result.outcome).toBe('limit_reached')
      expect(isFailReason(result.outcome)).toBe(true)
      await failTurn(sql, claim, result.outcome as 'limit_reached', 0n, result.text)
      const msgs = await sql`select content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.conversation)
    })
  })
})
