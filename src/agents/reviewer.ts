import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { z } from 'zod'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import {
  buildCountTokensRequest, buildRequest, callModel, estimateInputTokens,
  type CallArgs, type ModelResult, type Transport,
} from '../model/client.js'
import { costMicros } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { recordGateResults } from '../repo/gateResults.js'
import { renderNotebook } from '../repo/notebook.js'
import { formatMoney, type Money } from '../money.js'
import { maskUntrustedText, sanitizeSourceId } from '../sanitize.js'
import { fenceResult } from '../tools/validate.js'
import type { RehydratedItem } from '../gates/types.js'
import type { Notebook } from '../notebook.js'

const SYSTEM = readFileSync(new URL('./prompts/reviewer.md', import.meta.url), 'utf8')

/** Spec section 5: `rounds < MAX_ROUNDS`. Two verdicts, then ship unapproved. */
export const MAX_REVIEW_ROUNDS = 2

const Verdict = z.strictObject({ approved: z.boolean(), issues: z.array(z.string().max(500)).max(20) })
export type ReviewVerdict = z.infer<typeof Verdict>

/** Hand-written rather than `z.toJSONSchema(Verdict)`: the API rejects `maxItems`/`maxLength`, which zod would emit. */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
  required: ['approved', 'issues'],
  additionalProperties: false,
}

export type ReviewResult =
  | {
      kind: 'verdict'; verdict: ReviewVerdict
      /**
       * ALREADY DEBITED, via this call's own `reserve`/`reconcile` — the
       * opposite of `AgentStep.costMicros` (`src/worker.ts`), whose doc
       * comment on `makeDriver` (`src/agents/driver.ts`, "Who charges for
       * the model call") names the same hazard: a caller that also passes
       * this to `recordSpend` bills the identical increment a second time.
       * There is nothing left for a caller to charge; this field exists so
       * the caller can report the real cost, not so it can spend it again.
       */
      costMicros: bigint
    }
  | { kind: 'skipped_limit'; costMicros: 0n }

export type ReviewDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * The offer as the reviewer reads it. Prices are the CORPUS's (rehydrated), so
 * showing them is not a leak; each carries its age because a stale price is a
 * reviewable fault.
 *
 * Every supplier-written string is masked with `maskUntrustedText` before it
 * is interpolated — `item.name` (`SearchApiSupplier` sets it straight from
 * the third-party payload, `src/supplier/searchapi.ts`), each flight number,
 * the flown airports, the departure times, and the hotel dates. `ref.slot`
 * is NOT masked: it comes from `ItemRef`'s zod enum (`SLOT_KINDS`,
 * `src/gates/rehydrateGate.ts`), not from a supplier, so there is nothing
 * untrusted in it.
 *
 * The rendered lines — but not the "Server total" line below, which this
 * repo computed — are wrapped in the same untrusted-data fence every other
 * supplier/tool result crosses (`fenceResult`, `src/tools/validate.ts`): a
 * masked supplier name cannot contain the fence's own delimiters or a raw
 * newline, but fencing is the belt to masking's suspenders, and it is what
 * marks the whole block's PROVENANCE as unambiguous to the reviewer model,
 * exactly as it does for the driver.
 */
export function renderOfferForReview(items: RehydratedItem[], total: Money, now: Date): string {
  const lines = items.map(({ ref, item }) => {
    const ageMin = Math.max(0, Math.round((now.getTime() - item.fetchedAt.getTime()) / 60_000))
    const d = item.detail
    const name = maskUntrustedText(item.name)
    const what = d.kind === 'flight'
      ? `${maskUntrustedText(d.outbound.from)}→${maskUntrustedText(d.outbound.to)} `
        + `${maskUntrustedText(d.outbound.departureLocal)} flights `
        + `${d.outbound.flightNumbers.map(maskUntrustedText).join('+')}`
        + (d.inbound
          ? `, back ${maskUntrustedText(d.inbound.departureLocal)} flights `
            + `${d.inbound.flightNumbers.map(maskUntrustedText).join('+')}`
          : '')
        + `, ${d.outbound.stops} stop(s)`
      : `${maskUntrustedText(d.checkIn)} to ${maskUntrustedText(d.checkOut)}, ${d.nights} night(s)`
    return `- ${ref.slot}: ${sanitizeSourceId(item.sourceId)} — ${name} — ${what} — `
         + `${formatMoney(item.price)} (${item.priceBasis}, fetched ${ageMin} min ago)`
  })
  return `## The offer\n\n${fenceResult('offer', 'api', lines.join('\n'))}\n\n`
       + `Server total: ${formatMoney(total)}`
}

/**
 * One Opus call, charged like the driver's: reserve, call, reconcile, record.
 * Writes exactly one `reviewer` row in gate_results at `args.round`.
 *
 * Never approves by accident: a refusal, a malformed body, or `approved: true`
 * with issues is a rejection carrying a synthetic issue that names the cause.
 * Spec section 8: "a refused reviewer call is never read as approval."
 */
export async function reviewOffer(
  deps: ReviewDeps,
  ctx: { conversationId: string; userId: string; turnId: string },
  args: { items: RehydratedItem[]; total: Money; notebook: Notebook; round: number },
): Promise<ReviewResult> {
  const { sql } = deps
  const seat = SEATS.reviewer
  const now = new Date(deps.now())
  const callArgs: CallArgs = {
    seat, system: SYSTEM, tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: renderOfferForReview(args.items, args.total, now) }] }],
    suffix: renderNotebook(args.notebook) || '## The notebook, as recorded\n\n(empty)',
    outputSchema: REVIEW_SCHEMA,
  }

  const inputTokens = deps.transport.countTokens
    ? (await deps.transport.countTokens(buildCountTokensRequest(callArgs))).input_tokens
    : estimateInputTokens(callArgs)
  const reserved = estimateMicros(seat, inputTokens)
  const { conversationMicros, dailyMicros, day } = await reserve(sql, {
    userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved,
  })
  const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })

  // Deviation 3 in the plan: a ceiling here skips the review rather than
  // throwing out of run(); the next driver step fails the turn with her words.
  if (firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits) !== null) {
    await refund()
    return { kind: 'skipped_limit', costMicros: 0n }
  }

  let result: ModelResult
  try {
    result = await callModel(deps.transport, callArgs, deps.now)
  } catch (err) {
    if (classifyError(err).billed === 'no') await refund()
    throw err
  }
  const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
  await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
  await recordModelCall(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
    seat: 'reviewer', seatConfig: seat, result,
    systemPrompt: callArgs.system, userPrompt: callArgs.messages[0]!.content.map((b) => b.type === 'text' ? b.text : '').join(''),
    requestShape: buildRequest(callArgs), thinkingMode: 'adaptive', costMicros: actual,
  })

  const verdict = parseVerdict(result)
  await recordGateResults(sql, {
    conversationId: ctx.conversationId, turnId: ctx.turnId, proposalId: null, round: args.round,
    results: [verdict.approved
      ? { gate: 'reviewer', passed: true, detail: null, sourceIds: [] }
      : { gate: 'reviewer', passed: false, detail: verdict.issues.join('; '), sourceIds: [] }],
  })
  return { kind: 'verdict', verdict, costMicros: actual }
}

function parseVerdict(result: ModelResult): ReviewVerdict {
  if (result.kind === 'refused') return { approved: false, issues: ['The reviewer refused to assess this offer.'] }
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
  if (text.length === 0) return { approved: false, issues: ['The reviewer returned no verdict.'] }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { approved: false, issues: ['The reviewer\'s verdict was not readable.'] } }
  const parsed = Verdict.safeParse(raw)
  if (!parsed.success) return { approved: false, issues: ['The reviewer\'s verdict did not match the expected shape.'] }
  if (parsed.data.approved && parsed.data.issues.length > 0) {
    return { approved: false, issues: ['The reviewer approved while listing issues; treated as a rejection: ' + parsed.data.issues.join(' ')] }
  }
  if (!parsed.data.approved && parsed.data.issues.length === 0) {
    return { approved: false, issues: ['The reviewer rejected the offer without saying why.'] }
  }
  return parsed.data
}
