export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/**
 * Which ephemeral cache TTL a request asked for. It is a PRICE input, not a
 * transport detail: a 1-hour write costs 2x base input where a 5-minute write
 * costs 1.25x, and a caller that cannot say which one it sent cannot say what it
 * spent.
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
 * cache-write rate: src/model/cache.ts writes the system+tools prefix at 1h on
 * every driver call, and a field named `cacheWriteMult` is exactly the field
 * someone reaches for while pricing it.
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
  // src/repo/**: a guess that undercounts disables the guardrail silently.
  throw new Error(
    `costMicros: unknown cache write TTL ${JSON.stringify(ttl)}. Refusing to guess a rate.`,
  )
}

/**
 * Prices a single model call in USD micros. Rounds UP: a spending guardrail must
 * never undercount, so any fractional micro is charged in full.
 *
 * `cacheWriteTtl` is the TTL the REQUEST asked for, not something the response
 * reports — usage tells us how many tokens were written, never at which rate.
 * Cache writes and cache reads are billed from separate usage fields, roughly
 * 1.25x/2x and 0.1x of the input rate, because collapsing them into a single
 * "cached tokens" count cannot distinguish rates that differ by up to 20x.
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
