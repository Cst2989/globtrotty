import { describe, it, expect } from 'vitest'
import { decideNext, type DecideInput } from '../src/engine.js'

const LIMITS = {
  conversationCeilingMicros: 8_000_000n,   // $8
  dailyCeilingMicros: 15_000_000n,         // $15
  globalCeilingMicros: 50_000_000n,        // $50
  maxSteps: 24,
}

const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  state: { step: 0, messages: [], reviewRounds: 0 },
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
    const d = decideNext(base({ state: { step: 24, messages: [], reviewRounds: 0 } }))
    expect(d).toEqual({ kind: 'stop', reason: 'step_cap' })
  })

  // The 15-minute Netlify ceiling: hand off to a fresh invocation rather than be killed.
  it('continues later when the next step would not fit before the deadline', () => {
    const d = decideNext(base({ nowMs: 550_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })

  it('prefers stopping over continuing when the ceiling is also hit', () => {
    const d = decideNext(base({
      nowMs: 550_000,
      spend: { conversationMicros: 8_000_000n, dailyMicros: 0n, globalMicros: 0n },
    }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('is a pure function of its input', () => {
    const input = base()
    const before = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    decideNext(input)
    const after = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v))
    expect(after).toBe(before)
  })

  it('stops on the step cap even when the deadline has also passed', () => {
    const d = decideNext(base({ state: { step: 24, messages: [], reviewRounds: 0 }, nowMs: 550_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'stop', reason: 'step_cap' })
  })

  it('stops on the daily ceiling even when the step cap is also reached', () => {
    const d = decideNext(base({ spend: { conversationMicros: 10n, dailyMicros: 15_000_000n, globalMicros: 0n }, state: { step: 24, messages: [], reviewRounds: 0 } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('continues later when at the exact deadline boundary', () => {
    const d = decideNext(base({ nowMs: 540_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })
})

/**
 * The global ceiling — spec §8's "the cap that actually matters". It protects the
 * ACCOUNT, not one user, so it must be able to stop a turn whose own conversation
 * and daily totals are both zero: no per-user counter can ever see it coming.
 *
 * A note on precedence. The task brief wanted a `detail` discriminator on the stop
 * decision so a test could prove global is checked BEFORE conversation. It is not
 * added (its own example test asserts `toEqual({kind:'stop', reason:'limit_reached'})`,
 * which is exact and would reject the extra field, and five existing assertions here
 * would break too). The consequence is honest and worth stating: all three money
 * ceilings return the identical decision, so their relative order is not observable
 * from the outside and cannot be pinned by a test. What IS observable, and is pinned
 * below, is that the global ceiling beats the step cap and the deadline — i.e. that
 * money genuinely comes first.
 */
describe('decideNext: the global ceiling', () => {
  // Only the account-wide total is non-zero: neither per-user counter can see this.
  const accountOnly = (globalMicros: bigint) =>
    ({ conversationMicros: 0n, dailyMicros: 0n, globalMicros })

  it('calls the model one micro below the global ceiling', () => {
    expect(decideNext(base({ spend: accountOnly(49_999_999n) }))).toEqual({ kind: 'call_model' })
  })

  it('stops exactly AT the global ceiling, with this user having spent nothing', () => {
    const d = decideNext(base({ spend: accountOnly(50_000_000n) }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops one micro past the global ceiling', () => {
    const d = decideNext(base({ spend: accountOnly(50_000_001n) }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops on the global ceiling even when the step cap is also reached', () => {
    const d = decideNext(base({
      spend: accountOnly(50_000_000n), state: { step: 24, messages: [], reviewRounds: 0 },
    }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })   // not 'step_cap'
  })

  it('stops on the global ceiling rather than continuing later', () => {
    const d = decideNext(base({ spend: accountOnly(50_000_000n), nowMs: 550_000 }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })   // not 'continue_later'
  })

  it('ignores the global ceiling when only the OTHER ceilings are near', () => {
    // Guards against an implementation that compares the wrong pair of fields.
    const d = decideNext(base({
      spend: { conversationMicros: 7_999_999n, dailyMicros: 14_999_999n, globalMicros: 0n },
    }))
    expect(d).toEqual({ kind: 'call_model' })
  })
})
