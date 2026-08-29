import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner, type ToolRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { textMessage as classified } from './model/fake.js'

/** Counts supplier calls, the side effect a crash must not double. */
function countingRunner(): { run: ToolRunner; calls: number } {
  const inner = mockRunner(new MockSupplier())
  const counter = { calls: 0, run: (async (name, input) => { counter.calls += 1; return inner(name, input) }) as ToolRunner }
  return counter
}

const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const label = classified('{"label":"new_trip"}')
const requirements = classified('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}')
const crash = () => { throw new Error('process killed') }

describe('when the process dies mid-search', () => {
  it.fails('her turn survives and the supplier is called once', async () => {
    const supplier = countingRunner()
    const dying = fakeClient([label, requirements, search, crash])
    await expect(turn(newConversation(), HER_MESSAGE, dying, supplier.run)).rejects.toThrow('process killed')
    const retry = fakeClient([label, requirements, search, textMessage('Here are two hotels near the beach.')])
    const result = await turn(newConversation(), HER_MESSAGE, retry, supplier.run)
    expect(result.conversation.replies).toHaveLength(1)
    expect(supplier.calls).toBe(1)
  })
})
