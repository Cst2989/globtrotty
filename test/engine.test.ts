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
  spend: { conversationMicros: 0n, dailyMicros: 0n },
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
    const d = decideNext(base({ spend: { conversationMicros: 8_000_000n, dailyMicros: 0n } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('stops at the daily ceiling even when the conversation is cheap', () => {
    const d = decideNext(base({ spend: { conversationMicros: 10n, dailyMicros: 15_000_000n } }))
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
      spend: { conversationMicros: 8_000_000n, dailyMicros: 0n },
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
    const d = decideNext(base({ spend: { conversationMicros: 10n, dailyMicros: 15_000_000n }, state: { step: 24, messages: [], reviewRounds: 0 } }))
    expect(d).toEqual({ kind: 'stop', reason: 'limit_reached' })
  })

  it('continues later when at the exact deadline boundary', () => {
    const d = decideNext(base({ nowMs: 540_000, deadlineMs: 600_000, estStepMs: 60_000 }))
    expect(d).toEqual({ kind: 'continue_later' })
  })
})
