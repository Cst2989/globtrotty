import { APIError } from '@anthropic-ai/sdk/core/error'
import { classifyError } from './errors.js'

export type RetryOptions = {
  /** Total tries, not extra tries: 3 means one call and two retries. */
  maxAttempts?: number
  /** Injected so a test does not actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so the jitter is deterministic in a test. */
  random?: () => number
}

const DEFAULT_MAX_ATTEMPTS = 3
const BASE_MS = 1_000
const JITTER_MS = 500

/**
 * How long the provider asked us to wait, in milliseconds, or null when it said
 * nothing. Read defensively: the header is a string on a headers object the SDK
 * may or may not have attached, and a value we cannot parse is not a reason to
 * throw inside a retry helper.
 */
function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof APIError)) return null
  const raw = err.headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null
}

/**
 * Runs `work`, and tries again when the failure is the kind worth trying again.
 *
 * Which kind that is comes from `classifyError` (src/errors.ts) rather than from
 * a second opinion written here: a 400 and a 429 arriving as the same
 * "something failed" is exactly what the classifier exists to stop, and two
 * descriptions of the same taxonomy would eventually disagree.
 *
 * Exponential backoff, and then jitter on top. Backoff alone is not enough:
 * every client waits the same doubling interval and they all come back at the
 * same instant, so an API that is already unwell gets a synchronised wave rather
 * than a spread. For a fleet of agent workers that is worse than for ordinary
 * clients, because every one of them is the same program making the same
 * decision at the same moment. `Retry-After` beats both when the provider sent
 * one: it is the only party that knows.
 */
export async function withRetry<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work()
    } catch (err) {
      const { retryable } = classifyError(err)
      if (!retryable || attempt >= maxAttempts) throw err
      const told = retryAfterMs(err)
      const base = told ?? BASE_MS * 2 ** (attempt - 1)
      await sleep(base + random() * JITTER_MS)
    }
  }
}
