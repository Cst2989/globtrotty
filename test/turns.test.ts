import { randomUUID } from 'node:crypto'
import { newConversation, turn } from '../src/conversation.js'
import { isFailReason } from '../src/engine.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { claimTurn, completeTurn, failTurn, loadTurnInput, releaseForContinuation } from '../src/repo/turns.js'
import { mockRunner } from '../src/tools.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'
import { fakeClient, textMessage } from './model/fake.js'

const USER = randomUUID()

describeDb('loadTurnInput', () => {
  it('returns the message the turn was queued for', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
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
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-2',
      })
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await completeTurn(sql, claim, {
        state: { step: 0, messages: [] }, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 0n,
      })
      expect(await loadTurnInput(sql, submitted.turnId!)).toBeNull()
    })
  })

  // The reason the join is on the turn id and not on the conversation.
  it('ignores a later message on the same conversation', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
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

// The closers themselves, driven the way `runTurn` (src/worker.ts) drives
// them. Since lesson 3.6 tier 3 calls none of these three functions: its
// driver returns an `AgentStep` (netlify/functions/run-turn-background.mts)
// and the worker loop is what closes the turn. What these tests still pin is
// the pair of writes each closer makes, and the numbers the worker hands it,
// against real Postgres.
describeDb('completeTurn, the way the worker loop calls it', () => {
  it('writes the reply and closes the turn together', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-4' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await completeTurn(sql, claim, {
        state: { step: 1, messages: [] }, agentMessage: 'Two options near Faro.', parked: true, spendMicros: 0n,
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
        handlerDeps(sql),
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

  // The whole driver path, with the fake client standing in for the model: a
  // capped turn ends with her sentence on the row and the reason beside it.
  it('writes the exact capped sentence and fail_reason through the real driver path', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-6' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      const result = await turn(
        newConversation(input.conversationId), input.message,
        fakeClient([textMessage('never reached')]), mockRunner(),
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

  // Tier 3's driver reports `result.costMicros` on its fail step, and the
  // worker passes that number on to failTurn: a hand-picked constant here
  // would prove nothing about the money that was actually spent. This forces
  // the same limit_reached outcome one step later than the test above: under
  // ceiling on turn()'s own top-of-turn read, so classify (and extract, since
  // 'hi' does not parse as a faq) actually run and bill something, then over
  // ceiling on the loop's first per-step read. The turn still ends with no
  // model call inside the loop, but it is no longer free: a real cost was
  // already spent getting there, and it has to land on the row rather than
  // read as zero, which is what it did for two lessons while that driver
  // reported 0n.
  it('records the real cost the driver reports, not a hand-picked number', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-7' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      let reads = 0
      const result = await turn(
        newConversation(input.conversationId), input.message,
        fakeClient([textMessage('never reached')]), mockRunner(),
        {
          readSpend: async () => {
            reads += 1
            return reads === 1
              ? { conversationMicros: 0n, dailyMicros: 0n, globalMicros: 0n }
              : { conversationMicros: DEFAULT_LIMITS.conversationCeilingMicros, dailyMicros: 0n, globalMicros: 0n }
          },
        },
      )
      expect(result.outcome).toBe('limit_reached')
      expect(result.costMicros).toBeGreaterThan(0n)
      await failTurn(sql, claim, result.outcome as 'limit_reached', result.costMicros, result.text)
      const [t] = await sql`select spend_usd_micros from course.turns where id = ${submitted.turnId}`
      expect(BigInt(t!.spend_usd_micros as string)).toBe(result.costMicros)
    })
  })
})

// The driver's third branch: 'continue_later' is not an ending, so it must not
// reach either closer. Tier 3 returns that step and `runTurn` is what calls
// `releaseForContinuation`; this drives the same two calls in the same order,
// rather than exercising the netlify function itself, which there is no
// harness for in this repository (run-turn-background.mts's own docstring).
describeDb('continue_later, the way the worker loop handles it', () => {
  it('hands the lease back rather than closing the turn', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'turns-8' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      const input = (await loadTurnInput(sql, submitted.turnId!))!
      // A deadline already past leaves no room for even one more step, so the
      // loop hands back on its very first decision, before any model call.
      const result = await turn(
        newConversation(input.conversationId), input.message,
        fakeClient([textMessage('never reached')]), mockRunner(),
        { deadlineMs: Date.now() },
      )
      expect(result.outcome).toBe('continue_later')

      // The driver's own cost, exactly as tier 3 reports it on the step and
      // the worker passes it here: a hand-back is where a continued turn's
      // earlier attempts land on the row at all.
      await releaseForContinuation(sql, claim, { step: result.steps, messages: [] }, result.costMicros)

      const [t] = await sql`select status, state from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('queued')
      expect(t!.state).toEqual({ step: result.steps, messages: [] })

      // Claimable at once, not after a staleness window: the whole point of a
      // deliberate hand-back over leaving the row 'running'.
      const reclaimed = await claimTurn(sql, submitted.turnId!)
      expect(reclaimed?.attempts).toBe(2)
      expect(reclaimed?.state).toEqual({ step: result.steps, messages: [] })
    })
  })
})
