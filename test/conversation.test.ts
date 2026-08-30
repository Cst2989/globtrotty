import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { addUsage } from '../src/loop.js'
import { costMicros, type Usage } from '../src/pricing.js'
import { SpendUnconfirmedError } from '../src/repo/spend.js'
import { SEATS } from '../src/seats.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import { mockRunner } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { replayClient } from './model/replay.js'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from '../src/client.js'
import type { Supplier } from '../src/supplier/types.js'

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
    const run = mockRunner()
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
    const result = await turn(newConversation(), HER_MESSAGE, client, mockRunner(), {
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
  // catch, so anything but a resolved TurnResult would leave the turn's closer
  // unreached and her spinner never stopping.
  it('ends the turn instead of throwing when the first spend read cannot confirm', async () => {
    const client = fakeClient([textMessage('should never be reached')])
    const result = await turn(newConversation(), HER_MESSAGE, client, mockRunner(), {
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
      turn(newConversation(), HER_MESSAGE, client, mockRunner(), {
        readSpend: async () => { throw new Error('boom') },
      }),
    ).rejects.toThrow('boom')
    expect(client.calls).toBe(0)
  })
})

/**
 * The one test that watches the signal travel the whole way, because every
 * field it passes through is optional and a refactor that drops it breaks
 * nothing a type checker or any other test can see.
 *
 * `turn()` is given the signal a fenced worker would hand it: on tier 3 that
 * is `AgentContext.signal`, the controller `withHeartbeat` (src/worker.ts)
 * aborts the moment a heartbeat tick discovers this worker has been
 * superseded, handed straight into `turn()`'s options by the driver
 * (netlify/functions/run-turn-background.mts). Here an `AbortController` in
 * the test stands in for it, and both ends assert on that exact object rather
 * than on "some signal", because the whole point is that the fenced worker's
 * own signal is the one that reaches the wire.
 *
 * The route under test, all of it optional and none of it type-enforced:
 * TurnOptions.signal -> LoopOptions.signal (src/conversation.ts) -> callAndRecord's
 * meta.signal -> ModelClient.create's options (src/loop.ts, src/metered.ts,
 * src/client.ts) for the model end, and LoopOptions.signal -> the runner's
 * fourth argument (src/loop.ts) -> supplierRunner -> Supplier.search
 * (src/tools.ts) for the supplier end.
 */
describe('the abort signal a fenced worker hands to turn()', () => {
  /** Records the `options.signal` of every call, so each call can be told apart. */
  function signalCapturingClient(replies: Message[]): ModelClient & { signals: (AbortSignal | undefined)[] } {
    let next = 0
    const signals: (AbortSignal | undefined)[] = []
    return {
      signals,
      async create(_params, options) {
        signals.push(options?.signal)
        const reply = replies[Math.min(next, replies.length - 1)]
        next += 1
        if (!reply) throw new Error('signalCapturingClient has no replies')
        return reply
      },
    }
  }

  /** A supplier that answers nothing and only remembers what it was handed. */
  function signalCapturingSupplier(): Supplier & { seen: (AbortSignal | undefined)[] } {
    const seen: (AbortSignal | undefined)[] = []
    return {
      seen,
      name: 'capturing',
      kind: 'flight',
      capabilities: { live: false, mayRequote: false, maxAgeSeconds: 900, pricePersistence: 'none' },
      async search(_params, signal) { seen.push(signal); return [] },
      async quote() { return { status: 'gone' } },
    }
  }

  /** The loop half of any of the paths below: ask for a tool, then answer. */
  const loopReplies = (): Message[] => [
    toolUseMessage('search_flights', {
      from: 'BER', to: 'FAO', departureDate: '2026-09-12', returnDate: '2026-09-19',
      adults: 2, children: 0,
    }),
    textMessage('nothing found'),
  ]

  // `turn()` has TWO toolLoop call sites, one per desk, and a signal dropped
  // from either is invisible to the type checker. One test each.
  it('reaches both ends on the faq path, and is the same object at both', async () => {
    const controller = new AbortController()
    const flight = signalCapturingSupplier()
    const client = signalCapturingClient([textMessage('{"label":"faq"}'), ...loopReplies()])

    const result = await turn(
      newConversation(), 'Is Faro warm in September?', client,
      mockRunner({ ...mockSuppliers(), flight }),
      { signal: controller.signal },
    )

    expect(result.desk).toBe('front')
    expect(result.outcome).toBe('done')
    // The supplier end: src/tools.ts handed the search the caller's own signal.
    expect(flight.seen).toEqual([controller.signal])
    // The model end: both loop steps got it. Not merely "defined", the same object.
    expect(client.signals[1]).toBe(controller.signal)
    expect(client.signals[2]).toBe(controller.signal)
    // And the documented asymmetry, pinned rather than left to be rediscovered:
    // classify is a single short call on the cheap seat and is deliberately NOT
    // given the signal (src/conversation.ts), so a fence landing during it is
    // still paid for. README.md says so; this is what says so in the suite.
    expect(client.signals[0]).toBeUndefined()
  })

  it('reaches both ends on the planning path too, and skips classify and extract', async () => {
    const controller = new AbortController()
    const flight = signalCapturingSupplier()
    // classify, then extract (which tolerates an empty object), then the loop.
    const client = signalCapturingClient([
      textMessage('{"label":"new_trip"}'), textMessage('{}'), ...loopReplies(),
    ])

    const result = await turn(
      newConversation(), 'Plan me a week in Faro in September for two.', client,
      mockRunner({ ...mockSuppliers(), flight }),
      { signal: controller.signal },
    )

    expect(result.desk).toBe('planning')
    expect(flight.seen).toEqual([controller.signal])
    expect(client.signals[2]).toBe(controller.signal)
    expect(client.signals[3]).toBe(controller.signal)
    // Both cheap-seat calls, not just classify.
    expect(client.signals[0]).toBeUndefined()
    expect(client.signals[1]).toBeUndefined()
  })

  it('leaves every end undefined when the caller has no fence to enforce', async () => {
    // A script or a test has no signal to give, which is why every field on the
    // route is optional. `undefined` has to arrive as `undefined` rather than as
    // some default controller nothing will ever abort.
    const flight = signalCapturingSupplier()
    const client = signalCapturingClient([textMessage('{"label":"faq"}'), ...loopReplies()])

    await turn(newConversation(), 'Is Faro warm in September?', client, mockRunner({ ...mockSuppliers(), flight }))

    expect(flight.seen).toEqual([undefined])
    expect(client.signals.every((s) => s === undefined)).toBe(true)
  })
})
