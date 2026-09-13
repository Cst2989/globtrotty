import type { Message } from '@anthropic-ai/sdk/resources/messages'

export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/**
 * Which ephemeral cache TTL a request asked for. It is a PRICE input and not a
 * transport detail: a one hour write costs twice base input where a five minute
 * write costs 1.25 times, and a caller that cannot say which one it sent cannot
 * say what it spent.
 */
export type CacheTtl = '5m' | '1h'

type Price = {
  inMicrosPerToken: number
  outMicrosPerToken: number
  cacheWrite5mMult: number
  cacheWrite1hMult: number
  cacheReadMult: number
}

/**
 * USD micros per token. $5/MTok == 5 micros/token.
 *
 * The multipliers are kept per-model rather than as shared constants so a future
 * model whose cache pricing diverges is a one-line edit here, not a new concept.
 * They are named for their TTL because there is no such thing as "the"
 * cache-write rate: `src/model/cache.ts` writes the system and tools prefix at
 * 1h on every call (`SYSTEM_CACHE_TTL`), and a field named `cacheWriteMult` is
 * exactly the field somebody reaches for while pricing it.
 */
export const PRICES: Record<string, Price> = {
  'claude-opus-5': {
    inMicrosPerToken: 5, outMicrosPerToken: 25,
    cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1,
  },
  'claude-haiku-4-5-20251001': {
    inMicrosPerToken: 1, outMicrosPerToken: 5,
    cacheWrite5mMult: 1.25, cacheWrite1hMult: 2, cacheReadMult: 0.1,
  },
}

function writeMult(p: Price, ttl: CacheTtl): number {
  if (ttl === '5m') return p.cacheWrite5mMult
  if (ttl === '1h') return p.cacheWrite1hMult
  // Reachable only from untyped JS or a widened union. Fails closed rather than
  // picking the cheaper multiplier, for the same reason `?? 0` is banned in
  // src/repo: a guess that undercounts disables the guardrail silently.
  throw new Error(
    `costMicros: unknown cache write TTL ${JSON.stringify(ttl)}. Refusing to guess a rate.`,
  )
}

/**
 * Prices a single model call in USD micros. Rounds UP: a spending guardrail must
 * never undercount, so any fractional micro is charged in full.
 *
 * `cacheWriteTtl` is the TTL the REQUEST asked for and not something the
 * response reports: usage tells us how many tokens were written, never at which
 * rate. There is no default, because a `'5m'` default is how a call site that
 * forgot the argument under-bills a one hour write by sixty percent, with no
 * error, no failing test and no way to tell the result from a legitimately
 * small number.
 *
 * Cache writes and cache reads are billed from separate usage fields, 1.25 or 2
 * times and 0.1 times the input rate, because collapsing them into a single
 * "cached tokens" count cannot distinguish rates that differ by up to twenty
 * times.
 */
export function costMicros(model: string, u: Usage, cacheWriteTtl: CacheTtl): bigint {
  const p = PRICES[model]
  if (!p) throw new Error(`No price for model "${model}". Refusing to charge zero.`)
  const micros =
    u.input_tokens * p.inMicrosPerToken +
    u.cache_creation_input_tokens * p.inMicrosPerToken * writeMult(p, cacheWriteTtl) +
    u.cache_read_input_tokens * p.inMicrosPerToken * p.cacheReadMult +
    u.output_tokens * p.outMicrosPerToken
  return BigInt(Math.ceil(micros)) // round UP: never undercount a guardrail
}

/** The SDK reports cache fields as number | null; the price table wants numbers. */
export function usageOf(message: Message): Usage {
  return {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
  }
}

/** Dollars for a printout; the arithmetic stays in micros. */
export function dollars(micros: bigint): string {
  return `$${(Number(micros) / 1_000_000).toFixed(4)}`
}
