import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { replayClient } from './model/replay.js'

describe('a conversation', () => {
  it('carries her lowered budget into the second turn', async () => {
    const client = replayClient('conversation-budget-drop')
    const run = mockRunner(new MockSupplier())
    const first = await turn(newConversation(), HER_MESSAGE, client, run)
    expect(first.conversation.notebook.budget?.value.amount).toBe(1500)
    const second = await turn(first.conversation, 'Actually, let us keep it under 1,200 euros.', client, run)
    client.done()
    expect(second.conversation.notebook.budget?.value.amount).toBe(1200)
    expect(second.conversation.notebook.budget?.source).toBe('user')
    expect(second.conversation.notebook.destination?.value.toLowerCase()).toContain('portugal')
    expect(second.conversation.replies).toHaveLength(2)
  })
})
