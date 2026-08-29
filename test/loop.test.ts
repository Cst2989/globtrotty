import { RateLimitError } from '@anthropic-ai/sdk'
import { MAX_STEPS, toolLoop } from '../src/loop.js'
import { SEATS } from '../src/seats.js'
import { TOOLS } from '../src/tools.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'

const run = async () => ({ content: '[]', isError: false })
const base = { seat: SEATS.driver, system: 'test', userText: 'hi', tools: TOOLS, run }

describe('toolLoop', () => {
  it('stops a run that keeps asking for tools at the step cap', async () => {
    const client = fakeClient([toolUseMessage('search_flights', { from: 'BER', to: 'LIS', departureDate: '2026-09-18', returnDate: null, adults: 2, children: 1 })])
    const result = await toolLoop({ ...base, client })
    expect(result.outcome).toBe('step_cap')
    expect(result.steps).toBe(MAX_STEPS)
    expect(client.calls).toBe(MAX_STEPS)
  })
  it('honours a smaller cap', async () => {
    const client = fakeClient([toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })])
    const result = await toolLoop({ ...base, client, maxSteps: 3 })
    expect(result.steps).toBe(3)
    expect(result.toolTrace).toHaveLength(3)
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
})
