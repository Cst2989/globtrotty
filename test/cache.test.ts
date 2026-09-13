import { cacheableSystem, expectsCacheReads, MAX_BREAKPOINTS, placeBreakpoints, SYSTEM_CACHE_TTL } from '../src/model/cache.js'
import type { LoopMessage } from '../src/engine.js'
import { SEATS } from '../src/seats.js'

const text = (t: string) => ({ type: 'text' as const, text: t })
const thinking = () => ({ type: 'thinking' as const, thinking: 'hm', signature: 'sig' })
const marks = (out: LoopMessage[]) =>
  out.flatMap((m) => m.content.filter((b) => 'cache_control' in (b as object)))

describe('where the breakpoints go', () => {
  it('puts a rolling one on the last block of the transcript', () => {
    // The one that makes the GROWING transcript cacheable across steps, which is
    // the whole of the saving: the system prompt is one breakpoint and the
    // transcript is the thing that repeats twelve times.
    const out = placeBreakpoints([{ role: 'user', content: [text('a'), text('b')] }])
    expect(marks(out)).toHaveLength(1)
    expect((out[0]!.content[1] as { cache_control?: unknown }).cache_control).toBeDefined()
  })

  it('never marks a thinking block', () => {
    // A thinking block does not accept cache_control. The walk has to skip to
    // the next eligible block rather than special-case it, or a transcript that
    // happens to end on a thinking block sends a field the API rejects.
    const out = placeBreakpoints([{ role: 'assistant', content: [text('a'), thinking()] }])
    const marked = out[0]!.content.findIndex((b) => 'cache_control' in (b as object))
    expect(marked).toBe(0)
  })

  it('searches backwards for the last eligible block rather than reading the end', () => {
    // A trailing message with an empty content array would index at -1 and
    // throw, and a transcript whose last message is empty is what a turn that
    // ended on a park looks like.
    const out = placeBreakpoints([
      { role: 'user', content: [text('a')] },
      { role: 'assistant', content: [] },
    ])
    expect(marks(out)).toHaveLength(1)
  })

  it('returns an empty transcript unmarked rather than throwing', () => {
    expect(placeBreakpoints([])).toEqual([])
  })

  it('returns a thinking-only transcript unmarked rather than half marked', () => {
    const out = placeBreakpoints([{ role: 'assistant', content: [thinking()] }])
    expect(marks(out)).toHaveLength(0)
  })

  it('never places more than three on the transcript', () => {
    // Four is the hard API limit and one of the four is spent on system plus
    // tools, so the transcript gets three. A fifth is a 400.
    const long: LoopMessage[] = Array.from({ length: 40 }, () => ({
      role: 'user' as const, content: [text('x'), text('y')],
    }))
    expect(marks(placeBreakpoints(long)).length).toBeLessThanOrEqual(MAX_BREAKPOINTS - 1)
  })

  it('spaces the intermediates roughly every fifteen blocks', () => {
    // The lookback window is twenty blocks, so a breakpoint further than that
    // from the previous one caches nothing. Thirty-two blocks gives room for two
    // intermediates plus the rolling one.
    const long: LoopMessage[] = Array.from({ length: 16 }, () => ({
      role: 'user' as const, content: [text('x'), text('y')],
    }))
    const out = placeBreakpoints(long)
    const positions: number[] = []
    out.forEach((m, mi) => m.content.forEach((b, bi) => {
      if ('cache_control' in (b as object)) positions.push(mi * 2 + bi)
    }))
    expect(positions).toHaveLength(3)
    // Every gap inside the lookback window, and the last mark on the last block.
    expect(positions[0]).toBeLessThanOrEqual(20)
    expect(positions[1]! - positions[0]!).toBeLessThanOrEqual(20)
    expect(positions[2]).toBe(31)
  })

  it('defers a mark past a thinking block at an every-fifteen position', () => {
    // The counter advances on EVERY block so the spacing still respects the
    // lookback window, and the mark only lands on a block that can carry one. A
    // version that skipped thinking blocks in the count instead would drift the
    // spacing past twenty and cache nothing.
    const content = [
      ...Array.from({ length: 14 }, () => text('x')),
      thinking(),
      text('after'),
    ]
    const out = placeBreakpoints([{ role: 'assistant', content }])
    const marked = out[0]!.content
      .map((b, i) => ('cache_control' in (b as object) ? i : -1))
      .filter((i) => i >= 0)
    expect(marked).not.toContain(14)
    expect(marked).toContain(15)
  })

  it('does not mutate its input, because the input is persisted state', () => {
    // TurnState goes into course.turns.state. Stamping cache_control onto it
    // would write a transport concern into durable state, and a resumed turn
    // would then send breakpoints that were placed for a different request.
    const before: LoopMessage[] = [{ role: 'user', content: [text('a')] }]
    const copy = JSON.parse(JSON.stringify(before))
    placeBreakpoints(before)
    expect(before).toEqual(copy)
  })
})

describe('the stable head', () => {
  it('writes the system prompt at a one hour TTL', () => {
    // Rather than the five minute default, because a resumed turn, one the
    // sweeper requeued or one that ran out of wall clock and continued in a
    // fresh invocation, is always past five minutes, and that is exactly when a
    // warm cache is worth the most.
    const head = cacheableSystem('You are the planning desk.', [])
    expect(head.system).toEqual([{
      type: 'text', text: 'You are the planning desk.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }])
    expect(SYSTEM_CACHE_TTL).toBe('1h')
  })

  it('returns the tools unchanged, because they render in front of the system', () => {
    // Order on the wire is tools, then system, then messages, so a breakpoint on
    // the last system block already covers the tool definitions in front of it.
    const tools = [{ name: 'search_hotels' }]
    expect(cacheableSystem('s', tools).tools).toBe(tools)
  })
})

describe('when a cache read is worth asserting', () => {
  it('expects reads on Opus above 512 tokens and not below', () => {
    expect(expectsCacheReads(SEATS.driver, 512)).toBe(true)
    expect(expectsCacheReads(SEATS.driver, 511)).toBe(false)
  })

  it('expects nothing from the cheap seats below 4096 tokens', () => {
    // The minimum cacheable prefix is per model and is not monotonic across
    // generations: Haiku 4.5's is eight times Opus 5's. A blanket
    // "cache_read_input_tokens > 0" assertion would pass for the driver and
    // give false confidence about the front desk and the scouts.
    expect(expectsCacheReads(SEATS.scout, 4_095)).toBe(false)
    expect(expectsCacheReads(SEATS.scout, 4_096)).toBe(true)
  })

  it('gives an unknown model the highest minimum we know of', () => {
    // Under-reporting costs an assertion we did not make. Over-reporting
    // produces a green test claiming caching works when it does not.
    expect(expectsCacheReads({ ...SEATS.driver, model: 'claude-future' }, 1_000)).toBe(false)
  })
})
