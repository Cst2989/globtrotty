import { vi } from 'vitest'
import { APIError, APIConnectionError } from '@anthropic-ai/sdk/core/error'
import { withRetry } from '../src/retry.js'

const apiError = (status: number, headers = new Headers()): unknown =>
  APIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'boom' } }, undefined, headers)

/** Records what was slept rather than sleeping, so the test takes no time. */
function recorder(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

describe('withRetry', () => {
  it('returns the first answer when nothing fails', async () => {
    const work = vi.fn().mockResolvedValue('ok')
    const { sleep, waits } = recorder()
    expect(await withRetry(work, { sleep, random: () => 0 })).toBe('ok')
    expect(work).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('retries a rate limit and succeeds', async () => {
    const work = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue('ok')
    const { sleep, waits } = recorder()
    expect(await withRetry(work, { sleep, random: () => 0 })).toBe('ok')
    expect(work).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([1_000])
  })

  it('backs off exponentially and gives up at the attempt cap', async () => {
    const work = vi.fn().mockRejectedValue(apiError(503))
    const { sleep, waits } = recorder()
    await expect(withRetry(work, { sleep, random: () => 0, maxAttempts: 4 })).rejects.toThrow()
    expect(work).toHaveBeenCalledTimes(4)
    expect(waits).toEqual([1_000, 2_000, 4_000])     // one wait fewer than attempts
  })

  // Backoff alone leaves every client returning at the same instant, which for a
  // fleet of identical workers is one decision taken a thousand times. The
  // jitter is the part that breaks the lockstep, so it is asserted, not assumed.
  it('adds jitter, so a fleet does not return in lockstep', async () => {
    const work = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValue('ok')
    const { sleep, waits } = recorder()
    await withRetry(work, { sleep, random: () => 1 })
    expect(waits).toEqual([1_500])                   // 1000 base, 500 of jitter at random() = 1
  })

  it('honours Retry-After instead of guessing', async () => {
    const headers = new Headers({ 'retry-after': '7' })
    const work = vi.fn().mockRejectedValueOnce(apiError(429, headers)).mockResolvedValue('ok')
    const { sleep, waits } = recorder()
    await withRetry(work, { sleep, random: () => 0 })
    expect(waits).toEqual([7_000])                   // the provider told us when
  })

  it('does not retry a permanent request fault', async () => {
    const work = vi.fn().mockRejectedValue(apiError(400))
    const { sleep, waits } = recorder()
    await expect(withRetry(work, { sleep, random: () => 0 })).rejects.toThrow()
    expect(work).toHaveBeenCalledTimes(1)            // retrying a 400 is guaranteed waste
    expect(waits).toEqual([])
  })

  it('does not retry an error it cannot name', async () => {
    const work = vi.fn().mockRejectedValue(new TypeError('x is not a function'))
    const { sleep } = recorder()
    await expect(withRetry(work, { sleep, random: () => 0 })).rejects.toThrow(TypeError)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('retries a connection failure, which never reached the provider at all', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new APIConnectionError({ message: 'socket hang up' }))
      .mockResolvedValue('ok')
    const { sleep } = recorder()
    expect(await withRetry(work, { sleep, random: () => 0 })).toBe('ok')
    expect(work).toHaveBeenCalledTimes(2)
  })
})
