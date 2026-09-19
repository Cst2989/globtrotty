// Plan 4a, Task 7, fix round 1 (Important). `subscribeConversation`
// debounces `onChange` 250ms trailing — this exercises that with fake
// timers and a minimal fake Supabase client (just enough of
// `channel().on().on().subscribe()` to capture the two postgres_changes
// callbacks and let the test fire them directly), no real Realtime
// connection involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { subscribeConversation } from '../web/realtime.js'

function fakeSupabase() {
  const handlers: Array<() => void> = []
  const channel = {
    on: vi.fn((_event: string, _filter: unknown, cb: () => void) => {
      handlers.push(cb)
      return channel
    }),
    subscribe: vi.fn(() => channel),
  }
  const sb = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  } as unknown as SupabaseClient

  return { sb, fire: () => handlers.forEach((h) => h()) }
}

describe('subscribeConversation debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a burst of changes into a single onChange, 250ms after the last one', () => {
    const { sb, fire } = fakeSupabase()
    const onChange = vi.fn()
    subscribeConversation(sb, { conversationId: 'c1', userId: 'u1', onChange })

    fire()
    vi.advanceTimersByTime(100)
    fire()
    vi.advanceTimersByTime(100)
    fire()
    expect(onChange).not.toHaveBeenCalled()

    vi.advanceTimersByTime(249)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires onChange again for a change that arrives after the debounce window closed', () => {
    const { sb, fire } = fakeSupabase()
    const onChange = vi.fn()
    subscribeConversation(sb, { conversationId: 'c1', userId: 'u1', onChange })

    fire()
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)

    fire()
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending debounced call on unsubscribe', () => {
    const { sb, fire } = fakeSupabase()
    const onChange = vi.fn()
    const unsubscribe = subscribeConversation(sb, { conversationId: 'c1', userId: 'u1', onChange })

    fire()
    unsubscribe()
    vi.advanceTimersByTime(1000)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('still calls sb.removeChannel on unsubscribe', () => {
    const { sb } = fakeSupabase()
    const unsubscribe = subscribeConversation(sb, { conversationId: 'c1', userId: 'u1', onChange: vi.fn() })

    unsubscribe()

    expect(sb.removeChannel).toHaveBeenCalledTimes(1)
  })
})
