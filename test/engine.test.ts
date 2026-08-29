import { decideNext, exceedsAnyCeiling, type DecideInput } from '../src/engine.js'

const LIMITS = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50
  maxSteps: 24,
}

const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  state: { step: 0 },
  spend: { conversationMicros: 0n, dailyMicros: 0n, globalMicros: 0n },
  limits: LIMITS,
  nowMs: 1_000,
  deadlineMs: 600_000,
  estStepMs: 60_000,
  pendingUserMessage: null,
  ...over,
})

describe('decideNext', () => {
  it('calls the model when there is room', () => {
    expect(decideNext(base())).toEqual({ kind: 'call_model' })
  })

  it('stops at the conversation ceiling', () => {
    const d = decideNext(base({ spend: { conversationMicros: 8_000_000n, dailyMicros: 0n, globalMicros: 0n } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops at the daily ceiling even when the conversation is cheap', () => {
    const d = decideNext(base({ spend: { conversationMicros: 10n, dailyMicros: 15_000_000n, globalMicros: 0n } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops at the step cap', () => {
    expect(decideNext(base({ state: { step: 24 } }))).toEqual({ kind: 'stop', reason: 'step_cap' })
  })

  // The fifteen minute Netlify ceiling: hand off rather than be killed mid step.
  it('continues later when the next step would not fit before the deadline', () => {
    const d = decideNext(base({ nowMs: 550_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })

  it('continues later at the exact deadline boundary', () => {
    const d = decideNext(base({ nowMs: 540_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })

  it('prefers stopping over continuing when the ceiling is also hit', () => {
    const d = decideNext(base({
      nowMs: 550_000,
      spend: { conversationMicros: 8_000_000n, dailyMicros: 0n, globalMicros: 0n },
    }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops on the step cap even when the deadline has also passed', () => {
    const d = decideNext(base({ state: { step: 24 }, nowMs: 550_000 }))
    expect(d).toEqual({ kind: 'stop', reason: 'step_cap' })
  })

  it('stops on the daily ceiling even when the step cap is also reached', () => {
    const d = decideNext(base({
      spend: { conversationMicros: 10n, dailyMicros: 15_000_000n, globalMicros: 0n },
      state: { step: 24 },
    }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  /**
   * `pendingUserMessage` is carried and not read: module 3 is where a running
   * turn picks up what she typed while it worked. Pinned now so the day it
   * starts meaning something, this test goes red and says where.
   */
  it('ignores a pending message, for now', () => {
    expect(decideNext(base({ pendingUserMessage: 'and I forgot the crib' })))
      .toEqual({ kind: 'call_model' })
  })

  it('is a pure function of its input', () => {
    const input = base()
    const before = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    decideNext(input)
    const after = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    expect(after).toBe(before)
  })
})

/**
 * The global ceiling protects the account, not one user, so it must be able to
 * stop a turn whose conversation and daily totals are both zero. No per-user
 * counter can ever see it coming.
 *
 * All three money ceilings return the identical decision, so their relative
 * order is not observable from outside and no test can pin it. What is
 * observable, and is pinned below, is that money beats the step cap and the
 * deadline.
 */
describe('decideNext: the global ceiling', () => {
  const accountOnly = (globalMicros: bigint) =>
    ({ conversationMicros: 0n, dailyMicros: 0n, globalMicros })

  it('calls the model one micro below the global ceiling', () => {
    expect(decideNext(base({ spend: accountOnly(49_999_999n) }))).toEqual({ kind: 'call_model' })
  })

  it('stops exactly at the global ceiling, with this user having spent nothing', () => {
    expect(decideNext(base({ spend: accountOnly(50_000_000n) })))
      .toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops on the global ceiling even when the step cap is also reached', () => {
    const d = decideNext(base({ spend: accountOnly(50_000_000n), state: { step: 24 } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })   // not step_cap
  })

  it('stops on the global ceiling rather than continuing later', () => {
    const d = decideNext(base({ spend: accountOnly(50_000_000n), nowMs: 550_000 }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })   // not continue_later
  })

  it('ignores the global ceiling when only the other ceilings are near', () => {
    const d = decideNext(base({
      spend: { conversationMicros: 7_999_999n, dailyMicros: 14_999_999n, globalMicros: 0n },
    }))
    expect(d).toEqual({ kind: 'call_model' })
  })
})

/**
 * The money predicate itself. Lesson 2.6 gives it a second caller, the request
 * handler, and two copies of three comparisons is exactly how one tier ends up
 * enforcing a limit the other thinks it is enforcing: a typo'd field pair like
 * `dailyMicros >= globalCeilingMicros` type checks perfectly.
 *
 * Each ceiling is exercised alone, with the other two at zero, so an
 * implementation that compared the wrong pair of fields fails here rather than
 * being masked by a sibling counter that happens to be high too.
 */
describe('exceedsAnyCeiling', () => {
  const spend = (over: Partial<{
    conversationMicros: bigint; dailyMicros: bigint; globalMicros: bigint
  }> = {}) => ({ conversationMicros: 0n, dailyMicros: 0n, globalMicros: 0n, ...over })

  it('is false with all three counters at zero', () => {
    expect(exceedsAnyCeiling(spend(), LIMITS)).toBe(false)
  })

  it.each([
    ['conversation', 'conversationMicros', 8_000_000n],
    ['daily', 'dailyMicros', 15_000_000n],
    ['global', 'globalMicros', 50_000_000n],
  ] as const)('is exclusive below and inclusive at the %s ceiling', (_name, field, ceiling) => {
    expect(exceedsAnyCeiling(spend({ [field]: ceiling - 1n }), LIMITS)).toBe(false)
    expect(exceedsAnyCeiling(spend({ [field]: ceiling }), LIMITS)).toBe(true)
    expect(exceedsAnyCeiling(spend({ [field]: ceiling + 1n }), LIMITS)).toBe(true)
  })

  it('does not fire when every counter is one micro short of its own ceiling', () => {
    expect(exceedsAnyCeiling(
      spend({ conversationMicros: 7_999_999n, dailyMicros: 14_999_999n, globalMicros: 49_999_999n }),
      LIMITS)).toBe(false)
  })

  /**
   * A conversation spend of 20,000,000 is far above the $8 conversation ceiling
   * and below the $50 global one; a daily spend of 9,000,000 is above the
   * conversation ceiling and below the $15 daily one. An implementation that
   * compared conversation spend against the global ceiling calls the first fine,
   * and one that compared daily spend against the conversation ceiling calls the
   * second capped.
   */
  it('compares each counter against its own ceiling', () => {
    expect(exceedsAnyCeiling(spend({ conversationMicros: 20_000_000n }), LIMITS)).toBe(true)
    expect(exceedsAnyCeiling(spend({ dailyMicros: 9_000_000n }), LIMITS)).toBe(false)
    expect(exceedsAnyCeiling(spend({ globalMicros: 20_000_000n }), LIMITS)).toBe(false)
  })
})
