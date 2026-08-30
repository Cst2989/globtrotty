import type { ContentBlock, LoopMessage } from '../engine.js'
import type { CacheTtl } from '../pricing.js'
import type { Seat } from './seats.js'

/** Hard API limit: at most four cache breakpoints per request. */
export const MAX_BREAKPOINTS = 4
/** Stay inside the 20-block lookback window. */
export const INTERMEDIATE_EVERY = 15
/**
 * The TTL on the system+tools write. Exported because Task 10 must price this
 * exact write with `costMicros(model, usage, SYSTEM_CACHE_TTL)` — a 1h write
 * bills at 2x base input and a 5m write at 1.25x, so the constant on the wire
 * and the constant in the ledger have to be the same constant.
 */
export const SYSTEM_CACHE_TTL: CacheTtl = '1h'

/**
 * Below this many tokens a prefix silently does not cache at all — and the
 * figure is PER MODEL and non-monotonic, not a single global. Opus 5 is the
 * lowest of the current line-up; Haiku 4.5 is the highest, which is spec section
 * 7's "the cheap seats are not expected to cache at all".
 */
const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  'claude-opus-5': 512,
  'claude-haiku-4-5-20251001': 4_096,
}
/**
 * An unknown model gets the HIGHEST minimum we know of. `expectsCacheReads`
 * gates test assertions: under-reporting costs an assertion we did not make,
 * over-reporting produces a green test claiming caching works when it does not.
 */
const MIN_CACHEABLE_FALLBACK = 4_096

/** Block types that accept `cache_control`. `thinking` does NOT. */
const CACHEABLE_BLOCK_TYPES: ReadonlySet<string> =
  new Set(['text', 'tool_use', 'tool_result', 'image', 'document'])

const canCarryBreakpoint = (b: ContentBlock | undefined): boolean =>
  b !== undefined && CACHEABLE_BLOCK_TYPES.has(b.type)

/**
 * Caching is a PREFIX match: any byte change anywhere in the prefix invalidates
 * everything after it. Render order is tools -> system -> messages.
 *
 * v1's mistake (spec section 7): one breakpoint on the last system block, with
 * the transcript sent after it. In a 20-step loop the transcript is the thing
 * that grows and repeats — precisely what caching exists for — and it was never
 * cached.
 *
 * The corrected layout spends the four breakpoints as:
 *   1. system + tools, 1h TTL          (cacheableSystem, below)
 *   2. an intermediate every ~15 blocks (stays inside the 20-block lookback)
 *   3. ditto
 *   4. a ROLLING breakpoint on the last block of the most recent turn
 *
 * Memory and the notebook are deliberately NOT cached: they change every turn,
 * so anything cached behind them would be invalidated on every request. They
 * belong after the last breakpoint.
 */
export function placeBreakpoints(messages: LoopMessage[]): LoopMessage[] {
  if (messages.length === 0) return []

  // Deep copy: a caller's TurnState is persisted to turns.state, and stamping
  // cache_control onto it would write a transport concern into durable state.
  const out: LoopMessage[] = JSON.parse(JSON.stringify(messages))

  // One of the four is spent on system+tools, so the transcript gets three.
  const budget = MAX_BREAKPOINTS - 1

  // Walk the flattened block sequence. The counter advances on EVERY block, so
  // the spacing still respects the 20-block lookback, but a breakpoint is only
  // placed on a block that can carry one — a `thinking` block at an every-15
  // position defers the mark to the next eligible block rather than being
  // stamped with a field the API rejects.
  const positions: Array<[number, number]> = []
  let sinceLast = 0
  for (let m = 0; m < out.length; m++) {
    const content = out[m]!.content
    for (let b = 0; b < content.length; b++) {
      sinceLast++
      if (sinceLast < INTERMEDIATE_EVERY) continue
      if (!canCarryBreakpoint(content[b])) continue
      positions.push([m, b])
      sinceLast = 0
    }
  }

  // The rolling breakpoint always wins a slot: it is the one that makes the
  // GROWING transcript cacheable across steps. Searched BACKWARDS for the last
  // eligible block rather than assumed to be `content.at(-1)` — a trailing
  // message with an empty `content` array, or one ending in a thinking block,
  // would otherwise index at -1 and throw.
  let rolling: [number, number] | null = null
  for (let m = out.length - 1; m >= 0 && rolling === null; m--) {
    const content = out[m]!.content
    for (let b = content.length - 1; b >= 0; b--) {
      if (canCarryBreakpoint(content[b])) { rolling = [m, b]; break }
    }
  }
  // A transcript with nothing that can carry a breakpoint is returned unmarked
  // rather than half-marked. It cannot happen with a real transcript; it is what
  // keeps the empty and thinking-only cases from throwing.
  if (rolling === null) return out

  // Keep the intermediates nearest the end — the earliest prefix is already
  // covered by the system breakpoint, and older positions expire first.
  const chosen: Array<[number, number]> = [
    ...positions
      .filter(([m, b]) => !(m === rolling![0] && b === rolling![1]))
      .slice(-(budget - 1)),
    rolling,
  ]

  for (const [m, b] of chosen) {
    const block = out[m]!.content[b] as unknown as Record<string, unknown>
    block.cache_control = { type: 'ephemeral' }
  }
  return out
}

/**
 * The stable prefix: tools first, then the frozen system prompt, with a 1h TTL.
 *
 * 1h rather than the 5-minute default because a resumed turn — one the sweeper
 * requeued, or one that hit the wall clock and continued in a fresh invocation —
 * is always past five minutes, and that is exactly when a warm cache is worth
 * the most. It is also 2x base input to write rather than 1.25x, which Task 2b
 * prices and Task 10 passes on to the ledger.
 *
 * `tools` comes back unchanged, and deliberately so: the render order is tools
 * -> system -> messages, so a breakpoint on the last system block already covers
 * the tool definitions in front of it. It is returned rather than dropped so the
 * caller has one function to ask for "the cacheable head of the request".
 */
export function cacheableSystem(
  system: string, tools: unknown[],
): { system: unknown[]; tools: unknown[] } {
  return {
    system: [{
      type: 'text', text: system,
      cache_control: { type: 'ephemeral', ttl: SYSTEM_CACHE_TTL },
    }],
    tools,
  }
}

/**
 * Whether a cache-read assertion is meaningful for this seat at this prompt size.
 *
 * Scoped per seat deliberately (spec section 7): the cheap seats have a much
 * higher minimum cacheable prefix — Haiku 4.5's is 4096 against Opus 5's 512 —
 * so they are not expected to cache at all at realistic prompt sizes. A blanket
 * "cache_read_input_tokens > 0" assertion across every seat would pass for the
 * driver and give false confidence about the others.
 */
export function expectsCacheReads(seat: Seat, promptTokens: number): boolean {
  const min = MIN_CACHEABLE_TOKENS[seat.model] ?? MIN_CACHEABLE_FALLBACK
  return promptTokens >= min
}
