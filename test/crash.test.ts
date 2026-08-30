import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { newConversation, turn } from '../src/conversation.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { beginToolCall } from '../src/repo/toolCalls.js'
import { claimTurn } from '../src/repo/turns.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { ledgerRunner, mockRunner, type ToolRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

const USER = randomUUID()

/** Counts supplier calls, the side effect a crash must not double, and keeps the last answer. */
function countingRunner(): { run: ToolRunner; calls: number; lastContent: string } {
  const inner = mockRunner(new MockSupplier())
  const counter = {
    calls: 0,
    lastContent: '',
    run: (async (name, input, callId) => {
      counter.calls += 1
      const outcome = await inner(name, input, callId)
      counter.lastContent = outcome.content
      return outcome
    }) as ToolRunner,
  }
  return counter
}

const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const label = textMessage('{"label":"new_trip"}')
const requirements = textMessage('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}')
const crash = () => { throw new Error('process killed') }

describeDb('when the process dies mid-search', () => {
  // submitMessage logs `invoke failed for turn <uuid>` on this path by design
  // (see src/handler.ts); the spy keeps that expected noise out of every run.
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errorSpy.mockRestore() })

  it('her message and her turn are still there afterwards', async () => {
    await withTestDb(async (sql) => {
      const supplier = countingRunner()
      // The work is scheduled by handing submitMessage an invoke that dies part
      // way through the turn, exactly as a killed process would.
      const invoke = async () => {
        const dying = fakeClient([label, requirements, search, crash])
        await turn(newConversation(), HER_MESSAGE, dying, supplier.run)
      }
      const result = await submitMessage({ sql, invoke, limits: DEFAULT_LIMITS }, {
        userId: USER, conversationId: null, message: HER_MESSAGE, idempotencyKey: 'crash-1',
      })

      const msgs = await sql`select role, content from course.messages where conversation_id = ${result.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toBe(HER_MESSAGE)
      const [t] = await sql`select status from course.turns where id = ${result.turnId}`
      expect(t!.status).toBe('queued')      // still waiting to be picked up
    })
  })
})

describeDb('when the process dies mid-search, the work itself', () => {
  it('is not repeated, and the supplier is called once', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: HER_MESSAGE, idempotencyKey: 'crash-2' },
      )
      const turnId = submitted.turnId!
      const claim = (await claimTurn(sql, turnId))!
      const supplier = countingRunner()
      const run = ledgerRunner(sql, claim, supplier.run)

      // The run that dies: the supplier answers, and the process is killed
      // before the reply is written.
      const dying = fakeClient([label, requirements, search, crash])
      await expect(turn(newConversation(submitted.conversationId), HER_MESSAGE, dying, run))
        .rejects.toThrow('process killed')
      expect(supplier.calls).toBe(1)

      // The resumed run asks the same questions in the same order here because
      // fakeClient is scripted to; the real model on the other end of
      // options.client is not, which is exactly what src/loop.ts's callId
      // comment and beginToolCall's name check are for.
      const retry = fakeClient([label, requirements, search, textMessage('Here are two hotels near the beach.')])
      const second = await turn(newConversation(submitted.conversationId), HER_MESSAGE, retry, run)

      expect(second.outcome).toBe('done')
      expect(supplier.calls).toBe(1)                       // still one, across a crash and a resume
      expect(second.toolTrace[0]?.content).toBe(supplier.lastContent)
      const rows = await sql`select call_id, status from course.tool_calls where turn_id = ${turnId}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('done')
    })
  })

  it('stops the turn rather than guess, when a call was started and never finished', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: USER, conversationId: null, message: HER_MESSAGE, idempotencyKey: 'crash-3' },
      )
      const turnId = submitted.turnId!
      const claim = (await claimTurn(sql, turnId))!
      const supplier = countingRunner()
      // A pending row with no result: the previous attempt died between writing
      // the intent and recording the outcome.
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')

      const client = fakeClient([label, requirements, search, textMessage('unreachable')])
      const result = await turn(
        newConversation(submitted.conversationId), HER_MESSAGE, client,
        ledgerRunner(sql, claim, supplier.run),
      )
      expect(result.outcome).toBe('ambiguous_tool_call')
      expect(supplier.calls).toBe(0)                       // it did not guess and run it again
    })
  })
})
