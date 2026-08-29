import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { addUsage } from '../src/loop.js'
import { costMicros, type Usage } from '../src/pricing.js'
import { SpendUnconfirmedError } from '../src/repo/spend.js'
import { SEATS } from '../src/seats.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { fakeClient, textMessage } from './model/fake.js'
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
    expect(first.conversation.notebook.budget?.value.minor).toBe(150000n)
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
    expect(second.conversation.notebook.budget?.value.minor).toBe(120000n)
    expect(second.conversation.notebook.budget?.source).toBe('user')
    expect(second.conversation.notebook.destination?.value.toLowerCase()).toContain('portugal')
    expect(second.conversation.replies).toHaveLength(2)
  })

  // classify is the FIRST model call a turn makes, before toolLoop's own
  // per-step ceiling check ever runs. Without this check at the top of
  // `turn()`, a capped account would still pay for classify (and, on the
  // planning path, extract) every time, which is the gap the tier-2 handler
  // comment claims is closed.
  it('checks the ceiling before classify, so a capped account pays for nothing', async () => {
    const client = fakeClient([textMessage('should never be reached')])
    const result = await turn(newConversation(), HER_MESSAGE, client, mockRunner(new MockSupplier()), {
      readSpend: async () => (
        { conversationMicros: DEFAULT_LIMITS.conversationCeilingMicros, dailyMicros: 0n, globalMicros: 0n }
      ),
    })
    expect(result.outcome).toBe('limit_reached')
    expect(client.calls).toBe(0)
  })

  // This top-of-turn read is the FIRST read of every tier-3 turn, so on a
  // database that cannot confirm spend, an uncaught throw here would escape
  // turn() itself and strand the turn at 'queued', before the loop's own
  // per-step guard ever gets a chance to run.
  // `turn()` resolving here, rather than rejecting, is the assertion that
  // matters: run-turn-background.mts awaits turn() in a try/finally with no
  // catch, so anything but a resolved TurnResult would leave finishTurn
  // unreached and her spinner never stopping.
  it('ends the turn instead of throwing when the first spend read cannot confirm', async () => {
    const client = fakeClient([textMessage('should never be reached')])
    const result = await turn(newConversation(), HER_MESSAGE, client, mockRunner(new MockSupplier()), {
      readSpend: async () => { throw new SpendUnconfirmedError('Cannot confirm conversation spend, fail closed, denying the request') },
    })
    expect(result.outcome).toBe('limit_reached')
    expect(client.calls).toBe(0)
  })

  // Only SpendUnconfirmedError is denied on. A plain Error, a bug in our own
  // code rather than a read that chose to fail closed, must still reach the
  // caller as a rejection.
  it('lets a plain Error from the first spend read propagate rather than denying on it', async () => {
    const client = fakeClient([textMessage('should never be reached')])
    await expect(
      turn(newConversation(), HER_MESSAGE, client, mockRunner(new MockSupplier()), {
        readSpend: async () => { throw new Error('boom') },
      }),
    ).rejects.toThrow('boom')
    expect(client.calls).toBe(0)
  })
})
