import { describe, expect, it } from 'vitest'
import {
  MAX_BREAKPOINTS, SYSTEM_CACHE_TTL, placeBreakpoints, cacheableSystem, expectsCacheReads,
} from '../src/model/cache.js'
import { SEATS } from '../src/model/seats.js'
import type { LoopMessage } from '../src/engine.js'

const turn = (i: number): LoopMessage => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: `turn ${i}` }],
})

const marked = (ms: LoopMessage[]) =>
  ms.flatMap((m, mi) =>
    m.content.flatMap((b, bi) =>
      (b as { cache_control?: unknown }).cache_control ? [`${mi}:${bi}`] : []))

describe('placeBreakpoints', () => {
  it('puts a rolling breakpoint on the LAST content block of the most recent turn', () => {
    const out = placeBreakpoints([turn(0), turn(1), turn(2)])
    const lastBlock = out.at(-1)!.content.at(-1) as { cache_control?: unknown }
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('adds an intermediate breakpoint roughly every 15 blocks', () => {
    const out = placeBreakpoints(Array.from({ length: 40 }, (_, i) => turn(i)))
    // 40 blocks: intermediates at 15 and 30, plus the rolling one at the end.
    expect(marked(out).length).toBe(3)
  })

  it('never exceeds the 4-breakpoint hard limit, however long the transcript', () => {
    const out = placeBreakpoints(Array.from({ length: 300 }, (_, i) => turn(i)))
    // One of the four is spent on system+tools, so the transcript gets at most 3.
    expect(marked(out).length).toBeLessThanOrEqual(MAX_BREAKPOINTS - 1)
  })

  it('never marks a thinking block — cache_control is not accepted there', () => {
    // Every 15th block is a thinking block, so a naive every-15 walk lands on
    // one every single time and the API rejects the request.
    const messages: LoopMessage[] = Array.from({ length: 40 }, (_, i) =>
      (i + 1) % 15 === 0
        ? { role: 'assistant' as const,
            content: [{ type: 'thinking' as const, thinking: `t${i}`, signature: `s${i}` }] }
        : turn(i))
    const out = placeBreakpoints(messages)
    for (const [mi, bi] of marked(out).map((s) => s.split(':').map(Number))) {
      expect(out[mi!]!.content[bi!]!.type).not.toBe('thinking')
    }
    expect(marked(out).length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to the previous turn when the last message carries no blocks', () => {
    // `content: []` gave the first draft `lastB = -1`; the `as Record` cast
    // compiles and then throws at runtime on `content[-1]`.
    const out = placeBreakpoints([turn(0), { role: 'user', content: [] }])
    expect(marked(out)).toEqual(['0:0'])
  })

  it('returns an empty transcript untouched rather than marking nothing-at-index--1', () => {
    expect(placeBreakpoints([])).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = [turn(0)]
    const snapshot = JSON.parse(JSON.stringify(input))
    placeBreakpoints(input)
    expect(input).toEqual(snapshot)
  })
})

describe('cacheableSystem', () => {
  it('caches system+tools with a 1h TTL — a resumed turn is past the 5m default', () => {
    const { system } = cacheableSystem('You are a travel agent.', [{ name: 'ask_user' }])
    const block = system.at(-1) as { cache_control?: { type: string; ttl?: string } }
    expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: SYSTEM_CACHE_TTL })
    expect(SYSTEM_CACHE_TTL).toBe('1h')   // the TTL Task 2b prices at 2x
  })
})

describe('expectsCacheReads', () => {
  it('is per model, and pins Opus 5 at 512 on both sides of the boundary', () => {
    expect(expectsCacheReads(SEATS.driver, 511)).toBe(false)
    expect(expectsCacheReads(SEATS.driver, 512)).toBe(true)
  })

  it('pins Haiku 4.5 at 4096 on both sides — the cheap seats barely cache at all', () => {
    // Spec section 7 names this figure: a blanket "cache_read_input_tokens > 0"
    // assertion across every seat would pass for the driver and give false
    // confidence about the others.
    expect(expectsCacheReads(SEATS.scout, 4_095)).toBe(false)
    expect(expectsCacheReads(SEATS.scout, 4_096)).toBe(true)
  })

  it('is false for a cheap seat at a realistic prompt size', () => {
    expect(expectsCacheReads(SEATS.scout, 2_000)).toBe(false)
  })

  it('is true for the driver once the prefix clears the minimum', () => {
    expect(expectsCacheReads(SEATS.driver, 4_000)).toBe(true)
  })

  it('assumes the HIGHEST known minimum for a model it does not know', () => {
    // Under-reporting a cache read is a missing assertion; over-reporting is a
    // test that says caching works when it does not.
    const unknown = { ...SEATS.driver, model: 'claude-something-6' }
    expect(expectsCacheReads(unknown, 2_048)).toBe(false)
    expect(expectsCacheReads(unknown, 4_096)).toBe(true)
  })
})
