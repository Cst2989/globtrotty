import type { Message } from '@anthropic-ai/sdk/resources/messages'

export type Usage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/**
 * USD micros per token. $5/MTok == 5 micros/token.
 *
 * cacheWriteMult and cacheReadMult are kept per-model (rather than as shared
 * constants) so the brief's produced shape, a single PRICES record carrying
 * everything needed to price a call, holds even if a future model's cache
 * multipliers diverge from today's.
 */
export const PRICES: Record<
  string,
  { inMicrosPerToken: number; outMicrosPerToken: number; cacheWriteMult: number; cacheReadMult: number }
> = {
  'claude-opus-5': { inMicrosPerToken: 5, outMicrosPerToken: 25, cacheWriteMult: 1.25, cacheReadMult: 0.1 },
  'claude-haiku-4-5-20251001': { inMicrosPerToken: 1, outMicrosPerToken: 5, cacheWriteMult: 1.25, cacheReadMult: 0.1 },
}

/**
 * Prices a single model call in USD micros. Rounds UP: a spending guardrail
 * must never undercount, so any fractional micro is charged in full.
 *
 * Cache writes and cache reads are billed from separate usage fields,
 * roughly 1.25x and 0.1x of the input rate, because collapsing them into a
 * single "cached tokens" count cannot distinguish a rate that differs by
 * 12.5x between the two.
 */
export function costMicros(model: string, u: Usage): bigint {
  const p = PRICES[model]
  if (!p) throw new Error(`No price for model "${model}". Refusing to charge zero.`)
  const micros =
    u.input_tokens * p.inMicrosPerToken +
    u.cache_creation_input_tokens * p.inMicrosPerToken * p.cacheWriteMult +
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
