import { APIError } from '@anthropic-ai/sdk/core/error'
import { classifyError } from './errors.js'

export type RetryOptions = {
  /** Total tries, not extra tries: 3 means one call and two retries. */
  maxAttempts?: number
  /** Injected so a test does not actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so the jitter is deterministic in a test. */
  random?: () => number
  /**
   * How much of the caller's own budget is left, in milliseconds, read fresh
   * on every attempt. Omitted, nothing is capped: a caller with no deadline of
   * its own (a test, a script) gets the plain exponential-plus-jitter wait.
   * A caller inside a time-boxed invocation (`runTurn`, src/worker.ts) passes
   * one, so a provider's `Retry-After` can never ask this function to sleep
   * past the moment the platform kills the process anyway.
   */
  remainingMs?: () => number
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
 *
 * Neither is trusted past `options.remainingMs()` when the caller supplies one.
 * A provider that answers `retry-after: 900` inside a fourteen-minute
 * invocation is not wrong to ask, but honouring it verbatim would sleep the
 * process past the moment the platform kills it: the turn is left `running`
 * with a heartbeat seconds old, unrecoverable for a further staleness window,
 * and the whole invocation bought nothing. Giving up here instead lets the
 * caller's OWN deadline handling decide what "not now" means for it (tier 3's
 * `continue_later`, which hands the lease back and reschedules), rather than
 * this function gambling the rest of the budget on a single sleep.
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
      const wait = base + random() * JITTER_MS
      const budget = options.remainingMs?.() ?? Infinity
      if (wait >= budget) throw err
      await sleep(wait)
    }
  }
}
