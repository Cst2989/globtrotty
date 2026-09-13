import { RateLimitError } from '@anthropic-ai/sdk'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { vi } from 'vitest'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { toolLoop } from '../src/loop.js'
import { SpendUnconfirmedError } from '../src/repo/spend.js'
import { SEATS } from '../src/seats.js'
import { toolsForDesk } from '../src/tools/registry.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'

const run = async () => ({ content: '[]', isError: false })
const base = { seat: SEATS.driver, system: 'test', userText: 'hi', tools: toolsForDesk('planning') as Tool[], run }

describe('toolLoop', () => {
  it('stops a run that keeps asking for tools at the step cap', async () => {
    const client = fakeClient([toolUseMessage('search_flights', { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null, adults: 2, children: 1 })])
    const result = await toolLoop({ ...base, client })
    expect(result.outcome).toBe('step_cap')
    expect(result.steps).toBe(DEFAULT_LIMITS.maxSteps)
    expect(client.calls).toBe(DEFAULT_LIMITS.maxSteps)
  })
  it('honours a smaller cap', async () => {
    const client = fakeClient([toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })])
    const result = await toolLoop({ ...base, client, limits: { ...DEFAULT_LIMITS, maxSteps: 3 } })
    expect(result.outcome).toBe('step_cap')
    expect(result.steps).toBe(3)
    expect(result.toolTrace).toHaveLength(3)
  })
  it('hands off instead of starting a step it cannot finish', async () => {
    const client = fakeClient([textMessage('Here is a plan.')])
    const result = await toolLoop({
      ...base, client,
      now: () => 550_000, deadlineMs: 600_000, estStepMs: 60_000,
    })
    expect(result.outcome).toBe('continue_later')
    expect(client.calls).toBe(0)          // not one token was spent
  })
  it('stops for money before it stops for steps', async () => {
    const client = fakeClient([textMessage('Here is a plan.')])
    const result = await toolLoop({
      ...base, client,
      limits: { ...DEFAULT_LIMITS, maxSteps: 0 },
      readSpend: async () => ({ conversationMicros: DEFAULT_LIMITS.conversationCeilingMicros, dailyMicros: 0n, globalMicros: 0n }),
    })
    expect(result.outcome).toBe('limit_reached')   // not step_cap
    expect(client.calls).toBe(0)
  })
  // readSpendFailClosed throws SpendUnconfirmedError when it cannot confirm
  // spend (src/repo/spend.ts). That throw must not escape toolLoop: this pins
  // that it ends the turn instead, the same way a confirmed ceiling hit
  // would, rather than stranding a caller who awaits `turn()` with no catch
  // of its own (run-turn-background.mts).
  it('ends the turn instead of throwing when the spend read cannot confirm', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = fakeClient([textMessage('Here is a plan.')])
      const result = await toolLoop({
        ...base, client,
        readSpend: async () => { throw new SpendUnconfirmedError('Cannot confirm conversation spend, fail closed, denying the request') },
      })
      expect(result.outcome).toBe('limit_reached')
      expect(client.calls).toBe(0)
    } finally {
      logged.mockRestore()
    }
  })
  // The catch above only recognises SpendUnconfirmedError. Anything else, a
  // plain bug in our own code or a caller-supplied reader, is not a failed
  // read and must not be swallowed into a quiet 'limit_reached': this is the
  // same rule the loop's own model-call catch applies to a non-APIError a few
  // lines below.
  it('lets a plain Error from readSpend propagate rather than denying on it', async () => {
    const client = fakeClient([textMessage('Here is a plan.')])
    await expect(
      toolLoop({
        ...base, client,
        readSpend: async () => { throw new Error('boom') },
      }),
    ).rejects.toThrow('boom')
    expect(client.calls).toBe(0)
  })
  it('treats a refusal as an outcome, not an exception', async () => {
    const client = fakeClient([textMessage('I cannot help with that.', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' } } as never)])
    const result = await toolLoop({ ...base, client })
    expect(result.outcome).toBe('refused')
    expect(result.steps).toBe(1)
  })
  it('reports a provider outage instead of crashing', async () => {
    const client = fakeClient([() => { throw new RateLimitError(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers()) }])
    const result = await toolLoop({ ...base, client })
    expect(result.outcome).toBe('provider_down')
  })
  it('finishes on end_turn with the text', async () => {
    const client = fakeClient([textMessage('Here is a plan.')])
    const result = await toolLoop({ ...base, client })
    expect(result.outcome).toBe('done')
    expect(result.text).toBe('Here is a plan.')
  })
  it('lets a plain Error thrown by the client propagate, because a crash in our own code is not a provider failure', async () => {
    const client = fakeClient([() => { throw new Error('process killed') }])
    await expect(toolLoop({ ...base, client })).rejects.toThrow('process killed')
  })
})
