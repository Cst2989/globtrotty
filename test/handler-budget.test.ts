import { vi } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from '../src/client.js'
import { newConversation, turn } from '../src/conversation.js'
import { HER_MESSAGE } from '../src/her.js'
import { mockRunner } from '../src/tools.js'
import { textMessage, toolUseMessage } from './model/fake.js'

/** What a synchronous request handler gets before the platform takes the socket back. */
const HANDLER_BUDGET_MS = 10_000

/** What one call on the driver seat costs in wall clock, measured in module 1. */
const PER_CALL_MS = 45_000

const label = textMessage('{"label":"new_trip"}')
const requirements = textMessage('{"budget":{"amount":1500,"currency":"EUR"},"destination":"Portugal","originCity":"Berlin","nights":7,"month":"September","partySize":{"adults":2,"children":1,"infants":0},"nearBeach":true,"needsCrib":true}')
const search = toolUseMessage('search_hotels', { city: 'Lagos', checkIn: '2026-09-18', checkOut: '2026-09-25', adults: 2, children: 1 })
const answer = textMessage('Two hotels near the beach, both with a crib.')

/** A client that takes real planning time per call, on whatever clock is installed. */
function slowClient(perCallMs: number, replies: Message[]): ModelClient & { calls: number } {
  let next = 0
  const client = {
    calls: 0,
    async create() {
      client.calls += 1
      const reply = replies[Math.min(next, replies.length - 1)]!
      next += 1
      await new Promise((resolve) => setTimeout(resolve, perCallMs))
      return reply
    },
  }
  return client
}

describe('her turn inside a request handler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is still on its first model call when the handler has already been cut off', async () => {
    const client = slowClient(PER_CALL_MS, [label, requirements, search, answer])
    const finished = vi.fn()
    // Not awaited: the point of the test is what is true while it is still running.
    void turn(newConversation(), HER_MESSAGE, client, mockRunner()).then(finished)

    await vi.advanceTimersByTimeAsync(HANDLER_BUDGET_MS)
    expect(finished).not.toHaveBeenCalled()
    expect(client.calls).toBe(1)          // one of four, and the socket is gone

    // She would have to wait this long for a reply the handler can no longer send.
    await vi.advanceTimersByTimeAsync(4 * PER_CALL_MS)
    expect(finished).toHaveBeenCalled()
  })
})
