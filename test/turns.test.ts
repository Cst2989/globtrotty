import { newConversation, turn } from '../src/conversation.js'
import { isFailReason } from '../src/engine.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { finishTurn, loadTurnInput } from '../src/repo/turns.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { fakeClient, textMessage } from './model/fake.js'

const USER = '11111111-1111-1111-1111-111111111111'

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
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      await finishTurn(sql, input, 'Two options near Faro.')
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

describeDb('finishTurn', () => {
  it('writes the reply and closes the turn together', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-4',
      })
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      await finishTurn(sql, input, 'Two options near Faro.')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe('Two options near Faro.')
      const [t] = await sql`select status, finished_at from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.finished_at).not.toBeNull()
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('active')
    })
  })

  // Without a fail reason passed here, a tier-3 ceiling denial would leave the
  // turn 'done' with no fail_reason and the conversation 'active',
  // indistinguishable from a normal reply, while tier 2's own ceiling denial
  // (src/handler.ts) leaves the conversation 'limit_reached'. Passing
  // 'limit_reached' here is how run-turn-background.mts makes the two tiers
  // describe the same denial the same way.
  it('records the same limit_reached reason tier 2 does, when passed one', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-5',
      })
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      await finishTurn(sql, input, '', 'limit_reached')
      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBe('limit_reached')
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('limit_reached')
    })
  })

  // The test above hands finishTurn a bare '' and 'limit_reached' directly,
  // so it would still pass unchanged if the sentence in src/limit-message.ts
  // were deleted. This one runs the real tier-3 path instead: `turn()`
  // (src/conversation.ts) sees a tripped
  // ceiling before the client is ever called, and its own `result.text` and
  // `result.outcome` are what reach finishTurn, exactly as
  // netlify/functions/run-turn-background.mts hands them over. It also picks
  // the CONVERSATION ceiling specifically: nothing else in the suite
  // exercises LIMIT_REACHED_MESSAGE.conversation or whichCeiling's
  // 'conversation' arm.
  it('writes the exact capped sentence and fail_reason through the real tier-3 path', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {}, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-6',
      })
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      const client = fakeClient([textMessage('should never be reached')])
      const result = await turn(
        newConversation(submitted.conversationId), input.message, client, mockRunner(new MockSupplier()),
        {
          readSpend: async () => (
            { conversationMicros: DEFAULT_LIMITS.conversationCeilingMicros, dailyMicros: 0n, globalMicros: 0n }
          ),
        },
      )
      expect(result.outcome).toBe('limit_reached')
      expect(client.calls).toBe(0)      // denied before classify, never mind the loop

      await finishTurn(sql, input, result.text, isFailReason(result.outcome) ? result.outcome : undefined)

      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs[1]!.role).toBe('agent')
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.conversation)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBe('limit_reached')
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('limit_reached')
    })
  })
})
