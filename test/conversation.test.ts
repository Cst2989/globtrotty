import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { addUsage } from '../src/loop.js'
import { costMicros, type Usage } from '../src/pricing.js'
import { SEATS } from '../src/seats.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { replayClient } from './model/replay.js'

const zeroCache = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// The first four recorded calls in the conversation-budget-drop fixture, in
// order: classify, extract, then the two planning-loop steps. Read straight
// off test/fixtures/model/conversation-budget-drop.json's usage fields.
const CLASSIFY_USAGE: Usage = { input_tokens: 317, output_tokens: 11, ...zeroCache }
const EXTRACT_USAGE: Usage = { input_tokens: 819, output_tokens: 65, ...zeroCache }
const LOOP_USAGE: Usage = addUsage(
  { input_tokens: 1271, output_tokens: 1047, ...zeroCache },
  { input_tokens: 3791, output_tokens: 1260, ...zeroCache },
)

describe('a conversation', () => {
  it('carries her lowered budget into the second turn', async () => {
    const client = replayClient('conversation-budget-drop')
    const run = mockRunner(new MockSupplier())
    const first = await turn(newConversation(), HER_MESSAGE, client, run)
    expect(first.conversation.notebook.budget?.value.amount).toBe(1500)
    // costMicros must cover every call this turn made: classify and extract
    // (both on the cheap seat) plus the two-step planning loop (on the
    // driver seat), not the loop alone.
    const loopOnly = costMicros(SEATS.driver.model, LOOP_USAGE)
    const wholeTurn =
      loopOnly + costMicros(SEATS.cheap.model, CLASSIFY_USAGE) + costMicros(SEATS.cheap.model, EXTRACT_USAGE)
    expect(first.costMicros).toBe(wholeTurn)
    expect(first.costMicros).toBeGreaterThan(loopOnly)
    const second = await turn(first.conversation, 'Actually, let us keep it under 1,200 euros.', client, run)
    client.done()
    expect(second.conversation.notebook.budget?.value.amount).toBe(1200)
    expect(second.conversation.notebook.budget?.source).toBe('user')
    expect(second.conversation.notebook.destination?.value.toLowerCase()).toContain('portugal')
    expect(second.conversation.replies).toHaveLength(2)
  })
})
