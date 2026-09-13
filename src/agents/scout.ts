import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { buildCountTokensRequest, buildRequest, callModel, estimateInputTokens, type CallArgs, type ModelResult, type Transport } from '../model/client.js'
import { costMicros, WEB_SEARCH_MICROS } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { cutAtWords, maskControlChars, maskUntrustedText, redactPrices } from '../sanitize.js'

const SYSTEM = readFileSync(new URL('./prompts/scout.md', import.meta.url), 'utf8')
export const SCOUT_MAX_WORDS = 300
export const SCOUT_MAX_SEARCHES = 3
/** The only tool a scout holds: read-only, server-side, no outbound channel of ours. */
export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: SCOUT_MAX_SEARCHES } as const

export type ScoutDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * Parent spec section 4: "One city, ≤300 words, words never prices." The brief is
 * a model's paraphrase of untrusted pages (section 10), so on the way back it is
 * price-redacted, control-masked, and cut — and the driver fences it because the
 * tool's door is 'worker'. Charged to her, like every seat (section 8), with the
 * search cap reserved up front because the count is only known afterwards.
 *
 * `ContentBlock` (src/engine.ts) does not declare `server_tool_use` or
 * `web_search_tool_result` — the two block types a search-enabled response can
 * carry alongside `text`. That is safe here: `callModel` casts `raw.content` to
 * `ContentBlock[]` without validating block shapes at runtime, so an unlisted
 * `type` simply rides along untouched; `recordModelCall` below only
 * JSON-stringifies `result.content` (no per-block field access), and this
 * function itself reads only blocks whose `type === 'text'`. No type change is
 * needed for either to tolerate them.
 */
export async function researchDestination(
  deps: ScoutDeps, ctx: { conversationId: string; userId: string; turnId: string },
  spent: { micros: bigint }, city: string,
): Promise<string> {
  const { sql } = deps
  const seat = SEATS.scout
  const args: CallArgs = {
    seat, system: SYSTEM, tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: `City: ${maskUntrustedText(city)}` }] }],
  }
  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
    : estimateInputTokens(args)
  const reserved = estimateMicros(seat, inputTokens, BigInt(SCOUT_MAX_SEARCHES) * WEB_SEARCH_MICROS)
  const { conversationMicros, dailyMicros, day } = await reserve(sql, { userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved })
  const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })
  if (firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits) !== null) {
    await refund()
    return 'No brief: the spending limit is reached. Plan from what you know, or ask her.'
  }
  let result: ModelResult
  try { result = await callModel(deps.transport, args, deps.now) }
  catch (err) { if (classifyError(err).billed === 'no') await refund(); throw err }
  const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
  await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
  spent.micros += actual
  await recordModelCall(sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'scout', seatConfig: seat, result, systemPrompt: SYSTEM, userPrompt: city,
    requestShape: buildRequest(args), thinkingMode: null, costMicros: actual })
  if (result.kind === 'refused') return 'No brief: the scout declined this city. Plan from what you know, or ask her.'
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
  if (text.length === 0) return 'No brief: the scout returned nothing. Plan from what you know, or ask her.'
  const { text: cut, cut: wasCut } = cutAtWords(maskControlChars(redactPrices(text)), SCOUT_MAX_WORDS)
  return wasCut ? `${cut}\n[brief cut at ${SCOUT_MAX_WORDS} words]` : cut
}
