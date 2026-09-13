import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import type { Notebook } from '../notebook.js'
import { renderNotebook } from '../repo/notebook.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { buildCountTokensRequest, buildRequest, callModel, estimateInputTokens, type CallArgs, type ModelResult, type Transport } from '../model/client.js'
import { costMicros, PRICES, WEB_SEARCH_MICROS } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { cutAtWords, maskControlChars, redactPrices } from '../sanitize.js'

const SYSTEM = readFileSync(new URL('./prompts/scout.md', import.meta.url), 'utf8')
export const SCOUT_MAX_WORDS = 300
export const SCOUT_MAX_SEARCHES = 3
/** The only tool a scout holds: read-only, server-side, no outbound channel of ours. */
export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: SCOUT_MAX_SEARCHES } as const
/**
 * A per-search bound on the search-RESULT tokens the provider folds into
 * `input_tokens` — the pages a search fetches and hands back to the model,
 * billed as ordinary input. Unknowable before dispatch (it depends on what the
 * pages actually contain), so this is a bound for the pre-dispatch reservation
 * below, not a measurement: `reconcile` still charges the true `actual` from
 * `usage` regardless of what this constant says. Priced at the seat's plain
 * input rate, for every one of the `SCOUT_MAX_SEARCHES` searches the tool
 * allows, alongside the flat per-call `WEB_SEARCH_MICROS` fee — the reservation
 * covered the fee alone before this, which left the result tokens themselves
 * unbounded.
 */
export const SCOUT_SEARCH_RESULT_TOKENS = 6_000

export type ScoutDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * Parent spec section 4: "One city, ≤300 words, words never prices." The brief is
 * a model's paraphrase of untrusted pages (section 10), so on the way back it is
 * price-redacted, control-masked, and cut — and the driver fences it because the
 * tool's door is 'worker'. Charged to her, like every seat (section 8), with the
 * search cap reserved up front because the count is only known afterwards.
 *
 * `city` is written by OUR OWN driver — the model calling this tool, not a
 * supplier — so it is masked with `maskControlChars` (the newline-injection
 * guard for our own model's output, src/sanitize.ts), not `maskUntrustedText`
 * (which caps at 128 characters and mangles non-ASCII, meant for
 * supplier-origin ids and names — "Málaga" is not an attack). zod's `.max(80)`
 * on the tool schema (src/tools/registry.ts) is the length bound here.
 *
 * `notebook` is rendered into `suffix`, the same volatile-context mechanism the
 * driver and reviewer use (`CallArgs.suffix` below; the cache-breakpoint layout
 * in `src/model/cache.ts`): it lands after the last cache breakpoint, so a
 * scout call never invalidates anything cached ahead of it, and it is what lets
 * the prompt talk about "this party" and "their month" rather than the bare
 * city name.
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
  spent: { micros: bigint }, city: string, notebook: Notebook,
): Promise<string> {
  const { sql } = deps
  const seat = SEATS.scout
  const p = PRICES[seat.model]
  if (!p) throw new Error(`No price for model "${seat.model}". Refusing to reserve zero.`)
  const cityLine = `City: ${maskControlChars(city)}`
  // Falls back to an explicit "(empty)" notebook rather than an empty string:
  // an empty `suffix` is skipped entirely by `withSuffix` (src/model/client.ts),
  // which would silently drop the "given the traveller's notebook" half of the
  // prompt's own framing instead of stating there is nothing in it yet.
  const suffix = renderNotebook(notebook) || '## The notebook, as recorded\n\n(empty)'
  const args: CallArgs = {
    seat, system: SYSTEM, tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: cityLine }] }],
    suffix,
  }
  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
    : estimateInputTokens(args)
  // Bounds two per-search cost classes only known AFTER the call: the flat
  // web-search fee, and SCOUT_SEARCH_RESULT_TOKENS worth of input per search —
  // both multiplied out to the full SCOUT_MAX_SEARCHES the tool allows, because
  // the count actually made is unknowable before dispatch.
  const perSearchMicros = WEB_SEARCH_MICROS + BigInt(SCOUT_SEARCH_RESULT_TOKENS * p.inMicrosPerToken)
  const reserved = estimateMicros(seat, inputTokens, BigInt(SCOUT_MAX_SEARCHES) * perSearchMicros)
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
  // The text actually SENT, not the raw `city` argument: `cityLine` plus the
  // notebook suffix, which `withSuffix` (src/model/client.ts) folds into this
  // same user turn on the wire.
  await recordModelCall(sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'scout', seatConfig: seat, result, systemPrompt: SYSTEM, userPrompt: `${cityLine}\n\n${suffix}`,
    requestShape: buildRequest(args), thinkingMode: null, costMicros: actual })
  if (result.kind === 'refused') return 'No brief: the scout declined this city. Plan from what you know, or ask her.'
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
  if (text.length === 0) return 'No brief: the scout returned nothing. Plan from what you know, or ask her.'
  const { text: cut, cut: wasCut } = cutAtWords(maskControlChars(redactPrices(text)), SCOUT_MAX_WORDS)
  return wasCut ? `${cut}\n[brief cut at ${SCOUT_MAX_WORDS} words]` : cut
}
