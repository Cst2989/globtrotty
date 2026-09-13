import type { Message } from '@anthropic-ai/sdk/resources/messages'

export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  /**
   * The cache write split by TTL, as the provider reports it, or null when it
   * reported none.
   *
   * Carried rather than flattened because ONE request can write at two TTLs at
   * once, and every driver request on this branch does: `cacheableSystem` writes
   * the system head at 1h and `placeBreakpoints` leaves the transcript marks at
   * the 5m default (src/model/cache.ts). `cache_creation_input_tokens` is the
   * sum across both and cannot say how it divided, so pricing that total at
   * either single rate is wrong for the other half.
   *
   * Optional, because a fixture and a fake write one usage object by hand and
   * neither has an opinion about TTLs. `costMicros` handles its absence
   * explicitly rather than defaulting it to zeroes, which would price a real
   * write as free.
   */
  cache_creation?: {
    ephemeral_5m_input_tokens: number
    ephemeral_1h_input_tokens: number
  } | null
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
 * What the cache WRITE half of one call cost, in raw micros before rounding.
 *
 * Two paths, and which one runs is decided by the response rather than by the
 * caller. When the provider sends `usage.cache_creation`, each bucket is priced
 * at its own rate, which is the only correct answer for a request that carries
 * breakpoints at two TTLs, and every driver request does.
 *
 * When it sends no split there is nothing in the response that says how the
 * total divided, so the total is priced whole at the TTL the CALLER declared.
 * Every call site that can write a cache at all declares `SYSTEM_CACHE_TTL`,
 * which is 1h and the dearer of the two rates, so that fallback errs HIGH and
 * never low: it can over-state a mixed write and cannot under-state one, which
 * is the only direction a spend figure may be wrong in.
 */
function creationMicros(p: Price, u: Usage, cacheWriteTtl: CacheTtl): number {
  // Read first and unconditionally, so an unknown TTL is refused on both paths
  // rather than only on the one that goes on to use the multiplier.
  const declared = writeMult(p, cacheWriteTtl)
  const split = u.cache_creation
  if (!split) return u.cache_creation_input_tokens * p.inMicrosPerToken * declared
  return (
    split.ephemeral_5m_input_tokens * p.cacheWrite5mMult +
    split.ephemeral_1h_input_tokens * p.cacheWrite1hMult
  ) * p.inMicrosPerToken
}

/**
 * Prices a single model call in USD micros. Rounds UP: a spending guardrail must
 * never undercount, so any fractional micro is charged in full.
 *
 * `cacheWriteTtl` is the TTL the REQUEST asked for, and it is what prices the
 * write whenever the response does not break the write down by TTL itself. There
 * is no default, because a `'5m'` default is how a call site that forgot the
 * argument under-bills a one hour write by sixty percent, with no error, no
 * failing test and no way to tell the result from a legitimately small number.
 *
 * It is NOT the whole story, and believing it was is how this function spent one
 * lesson over-charging: a request writes at every TTL its breakpoints carry, and
 * a driver request carries a 1h head and up to three 5m transcript marks. Where
 * the provider reports the split, `creationMicros` above prices each bucket at
 * its own rate and this argument only decides the fallback.
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
    creationMicros(p, u, cacheWriteTtl) +
    u.cache_read_input_tokens * p.inMicrosPerToken * p.cacheReadMult +
    u.output_tokens * p.outMicrosPerToken
  return BigInt(Math.ceil(micros)) // round UP: never undercount a guardrail
}

/**
 * The SDK reports cache fields as number | null; the price table wants numbers.
 *
 * `cache_creation` is copied across field by field rather than passed through by
 * reference, so the price input is a plain object this module owns and not a
 * live view of the SDK's response. It is the field that lets `costMicros` charge
 * a mixed-TTL request correctly, and it is null on every provider response that
 * predates the split.
 */
export function usageOf(message: Message): Usage {
  const split = message.usage.cache_creation
  return {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    cache_creation: split
      ? {
          ephemeral_5m_input_tokens: split.ephemeral_5m_input_tokens,
          ephemeral_1h_input_tokens: split.ephemeral_1h_input_tokens,
        }
      : null,
  }
}

/** Dollars for a printout; the arithmetic stays in micros. */
export function dollars(micros: bigint): string {
  return `$${(Number(micros) / 1_000_000).toFixed(4)}`
}
