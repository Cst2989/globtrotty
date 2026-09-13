import type { ContentBlock, LoopMessage } from '../engine.js'
import type { CacheTtl } from '../pricing.js'
import type { Seat } from '../seats.js'

/** Hard API limit: at most four cache breakpoints per request. */
export const MAX_BREAKPOINTS = 4
/** Stay inside the 20-block lookback window. */
export const INTERMEDIATE_EVERY = 15
/**
 * The TTL on the system+tools write, and on that write ONLY.
 *
 * Exported because `src/agents/driver.ts` prices with
 * `costMicros(model, usage, SYSTEM_CACHE_TTL)`, and it is worth being exact
 * about what that argument does, because one lesson was written believing it did
 * more. A request does not have "a" TTL: this constant rides on the system head
 * and `placeBreakpoints` leaves the transcript marks at the provider's five
 * minute default, so a driver request writes at BOTH rates and
 * `cache_creation_input_tokens` is the sum across them. What prices that
 * correctly is the provider's own `usage.cache_creation` split, which
 * `costMicros` reads whenever it is there. This constant is what the ledger
 * falls back to when it is not, and it is the dearer of the two rates, so the
 * fallback over-states a mixed write rather than under-stating one.
 */
export const SYSTEM_CACHE_TTL: CacheTtl = '1h'

/**
 * Below this many tokens a prefix silently does not cache at all, and the
 * figure is PER MODEL and non-monotonic, not a single global. Opus 5 is the
 * lowest of the current line-up; Haiku 4.5 is the highest, which is SPEC
 * section 7's "the cheap seats are not expected to cache at all".
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

/**
 * Block types that accept `cache_control`. `thinking` does NOT. This is not in
 * the published documentation; it was found against the live API while building
 * the v1 harness (globtrotty, `src/model/cache.ts`) and is recorded here as an
 * experimental result with a named source rather than cited to a page that does
 * not say it.
 */
const CACHEABLE_BLOCK_TYPES: ReadonlySet<string> =
  new Set(['text', 'tool_use', 'tool_result', 'image', 'document'])

const canCarryBreakpoint = (b: ContentBlock | undefined): boolean =>
  b !== undefined && CACHEABLE_BLOCK_TYPES.has(b.type)

/**
 * Caching is a PREFIX match: any byte change anywhere in the prefix invalidates
 * everything after it. Render order is tools, then system, then messages.
 *
 * The version this replaces put one breakpoint on the last system block and
 * sent the transcript after it. In a twelve step loop the transcript is the
 * thing that grows and repeats, which is precisely what caching exists for, and
 * it was never cached.
 *
 * The corrected layout spends the four breakpoints as:
 *   1. system + tools, 1h TTL           (cacheableSystem, below)
 *   2. an intermediate every ~15 blocks (stays inside the 20-block lookback)
 *   3. ditto
 *   4. a ROLLING breakpoint on the last block of the most recent turn
 *
 * Memory and the notebook are deliberately NOT cached: they change every turn,
 * so anything cached behind them would be invalidated on every request. They
 * belong after the last breakpoint, which is where `CallArgs.suffix`
 * (src/model/client.ts) puts them.
 */
export function placeBreakpoints(messages: LoopMessage[]): LoopMessage[] {
  if (messages.length === 0) return []

  // Deep copy: a caller's TurnState is persisted to course.turns.state, and
  // stamping cache_control onto it would write a transport concern into durable
  // state, so a resumed turn would send breakpoints placed for another request.
  const out: LoopMessage[] = JSON.parse(JSON.stringify(messages))

  // One of the four is spent on system+tools, so the transcript gets three.
  const budget = MAX_BREAKPOINTS - 1

  // Walk the flattened block sequence. The counter advances on EVERY block, so
  // the spacing still respects the 20-block lookback, but a breakpoint is only
  // placed on a block that can carry one: a `thinking` block at an every-15
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
  // eligible block rather than assumed to be `content.at(-1)`: a trailing
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

  // Keep the intermediates nearest the end: the earliest prefix is already
  // covered by the system breakpoint, and older positions expire first.
  const chosen: Array<[number, number]> = [
    ...positions
      .filter(([m, b]) => !(m === rolling![0] && b === rolling![1]))
      .slice(-(budget - 1)),
    rolling,
  ]

  for (const [m, b] of chosen) {
    const block = out[m]!.content[b] as unknown as Record<string, unknown>
    // No `ttl`, which is the provider's five minute default, and deliberately so
    // rather than by omission: the transcript is the part of the prompt that
    // changes on every step, so a mark placed here is read minutes later by the
    // next step of the same turn or it is not read at all. Paying the 1h premium
    // to store it for an hour buys nothing. The system head, which does survive
    // an hour, is the one that asks for `SYSTEM_CACHE_TTL`, and `costMicros`
    // prices the two apart from `usage.cache_creation` rather than charging the
    // whole write at either rate.
    block.cache_control = { type: 'ephemeral' }
  }
  return out
}

/**
 * The stable prefix: tools first, then the frozen system prompt, with a 1h TTL.
 *
 * 1h rather than the five minute default because a resumed turn, one the
 * sweeper requeued or one that hit the wall clock and continued in a fresh
 * invocation, is always past five minutes, and that is exactly when a warm cache
 * is worth the most. It is also twice base input to write rather than 1.25
 * times, which `src/pricing.ts` prices (`cacheWrite1hMult`) and which
 * `src/agents/driver.ts` passes on to the ledger, both in this same lesson.
 *
 * `tools` comes back unchanged, and deliberately so: the render order is tools,
 * then system, then messages, so a breakpoint on the last system block already
 * covers the tool definitions in front of it. It is returned rather than dropped
 * so the caller has one function to ask for "the cacheable head of the request".
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
 * Scoped per seat deliberately (SPEC section 7): the cheap seats have a much
 * higher minimum cacheable prefix, Haiku 4.5's 4096 against Opus 5's 512, so
 * they are not expected to cache at all at realistic prompt sizes. A blanket
 * "cache_read_input_tokens > 0" assertion across every seat would pass for the
 * driver and give false confidence about the others.
 */
export function expectsCacheReads(seat: Seat, promptTokens: number): boolean {
  const min = MIN_CACHEABLE_TOKENS[seat.model] ?? MIN_CACHEABLE_FALLBACK
  return promptTokens >= min
}
