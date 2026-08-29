import { newConversation, turn } from '../src/conversation.js'
import { submitMessage } from '../src/handler.js'
import { HER_MESSAGE } from '../src/her.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner, type ToolRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = '11111111-1111-1111-1111-111111111111'

/** Counts supplier calls, the side effect a crash must not double. */
function countingRunner(): { run: ToolRunner; calls: number } {
  const inner = mockRunner(new MockSupplier())
  const counter = { calls: 0, run: (async (name, input) => { counter.calls += 1; return inner(name, input) }) as ToolRunner }
  return counter
}

const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const label = textMessage('{"label":"new_trip"}')
const requirements = textMessage('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}')
const crash = () => { throw new Error('process killed') }

describeDb('when the process dies mid-search', () => {
  it('her message and her turn are still there afterwards', async () => {
    await withTestDb(async (sql) => {
      const supplier = countingRunner()
      // The work is scheduled by handing submitMessage an invoke that dies part
      // way through the turn, exactly as a killed process would.
      const invoke = async () => {
        const dying = fakeClient([label, requirements, search, crash])
        await turn(newConversation(), HER_MESSAGE, dying, supplier.run)
      }
      const result = await submitMessage({ sql, invoke }, {
        userId: USER, conversationId: null, message: HER_MESSAGE,
      })

      const msgs = await sql`select role, content from course.messages where conversation_id = ${result.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toBe(HER_MESSAGE)
      const [t] = await sql`select status from course.turns where id = ${result.turnId}`
      expect(t!.status).toBe('queued')      // still waiting to be picked up
    })
  })
})

describe('when the process dies mid-search, the work itself', () => {
  // Still open. The turn restarts from the beginning, so the supplier is called
  // twice. Lesson 3.4 closes this with a tool-call ledger and turns .fails into a
  // plain it.
  it.fails('is not repeated, and the supplier is called once', async () => {
    const supplier = countingRunner()
    const dying = fakeClient([label, requirements, search, crash])
    await expect(turn(newConversation(), HER_MESSAGE, dying, supplier.run)).rejects.toThrow('process killed')
    const retry = fakeClient([label, requirements, search, textMessage('Here are two hotels near the beach.')])
    await turn(newConversation(), HER_MESSAGE, retry, supplier.run)
    expect(supplier.calls).toBe(1)
  })
})
