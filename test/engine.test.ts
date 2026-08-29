import { describe, it, expect } from 'vitest'
import { decideNext, exceedsAnyCeiling, type DecideInput, type TurnState } from '../src/engine.js'

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

/**
 * The money predicate itself, now shared by `decideNext` and `submitMessage`
 * (src/handler.ts) instead of being written out twice. Two copies of a `>=`
 * comparison against three ceilings is the same hazard `DEFAULT_LIMITS`' doc
 * comment argues against for the numbers: a typo'd field pair
 * (`dailyMicros >= globalCeilingMicros`) type-checks perfectly and silently
 * enforces the wrong cap at one tier only.
 *
 * Each ceiling is exercised ALONE, with the other two at zero, so an
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

  // Both sides of every boundary: one micro below is room, exactly at is not.
  it.each([
    ['conversation', 'conversationMicros', 8_000_000n],
    ['daily', 'dailyMicros', 15_000_000n],
    ['global', 'globalMicros', 50_000_000n],
  ] as const)('is exclusive-below and inclusive-at the %s ceiling', (_name, field, ceiling) => {
    expect(exceedsAnyCeiling(spend({ [field]: ceiling - 1n }), LIMITS)).toBe(false)
    expect(exceedsAnyCeiling(spend({ [field]: ceiling }), LIMITS)).toBe(true)
    expect(exceedsAnyCeiling(spend({ [field]: ceiling + 1n }), LIMITS)).toBe(true)
  })

  it('does not fire when every counter is one micro short of its own ceiling', () => {
    expect(exceedsAnyCeiling(
      spend({ conversationMicros: 7_999_999n, dailyMicros: 14_999_999n,
              globalMicros: 49_999_999n }), LIMITS)).toBe(false)
  })

  /**
   * The cross-comparison guard. A conversation spend of 20_000_000 is far above
   * the $8 conversation ceiling but below the $50 global one, and a daily spend
   * of 9_000_000 is above the conversation ceiling but below the $15 daily one.
   * An implementation that compared conversation spend against the global
   * ceiling would call the first pair fine; one that compared daily spend
   * against the conversation ceiling would call the second pair capped.
   */
  it('compares each counter against its OWN ceiling', () => {
    expect(exceedsAnyCeiling(spend({ conversationMicros: 20_000_000n }), LIMITS)).toBe(true)
    expect(exceedsAnyCeiling(spend({ dailyMicros: 9_000_000n }), LIMITS)).toBe(false)
    expect(exceedsAnyCeiling(spend({ globalMicros: 20_000_000n }), LIMITS)).toBe(false)
  })
})

/**
 * The transcript shape itself. `LoopMessage` used to be
 * `{ role: 'user' | 'assistant' | 'tool'; content: string }`, which cannot carry
 * an Anthropic transcript: a tool result rides inside a USER message as a
 * `tool_result` block referencing the `id` of the `tool_use` that asked for it,
 * and a `thinking` block must be echoed back with its signature byte-for-byte.
 * Flattening either to a string destroys the id and the signature.
 */
describe('TurnState transcript blocks', () => {
  it('carries a tool_use block with its id and structured input intact', () => {
    const state: TurnState = {
      step: 1, reviewRounds: 0,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'find me flights' }] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'she wants BER to FAO', signature: 'sig-abc' },
          { type: 'tool_use', id: 'toolu_01', name: 'explore_flights',
            input: { from: 'BER', to: 'FAO' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: '{"results":3}' },
        ] },
      ],
    }
    const assistant = state.messages[1]!
    const use = assistant.content[1]
    expect(use).toMatchObject({ type: 'tool_use', id: 'toolu_01' })
    if (use?.type !== 'tool_use') throw new Error('unreachable')
    // The id must survive a jsonb round trip: turns.state is persisted as JSON.
    const roundTripped = JSON.parse(JSON.stringify(state)) as TurnState
    const back = roundTripped.messages[1]!.content[1]
    if (back?.type !== 'tool_use') throw new Error('unreachable')
    expect(back.id).toBe('toolu_01')
    expect(back.input).toEqual({ from: 'BER', to: 'FAO' })
    // A thinking block's signature must survive too — it is echoed back to the model.
    const think = roundTripped.messages[1]!.content[0]
    if (think?.type !== 'thinking') throw new Error('unreachable')
    expect(think.signature).toBe('sig-abc')
  })
})
