import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { z } from 'zod'
import type { Agent, AgentContext, AgentStep } from '../worker.js'
import { firstCeilingReached, type Limits } from '../engine.js'
import { classifyError } from '../errors.js'
import { SEATS } from '../model/seats.js'
import { SYSTEM_CACHE_TTL } from '../model/cache.js'
import { buildCountTokensRequest, buildRequest, callModel, estimateInputTokens, type CallArgs, type ModelResult, type Transport } from '../model/client.js'
import { costMicros } from '../pricing.js'
import { estimateMicros, reconcile, reserve } from '../repo/reservation.js'
import { recordModelCall } from '../repo/modelCalls.js'
import { recordFrontLabel, routeToPlanning } from '../repo/conversations.js'
import { maskControlChars } from '../sanitize.js'

const SYSTEM = readFileSync(new URL('./prompts/front_desk.md', import.meta.url), 'utf8')

export type FrontLabel = 'new_trip' | 'faq' | 'unclear' | 'fallback'

const Verdict = z.strictObject({
  label: z.enum(['new_trip', 'faq', 'unclear']),
  answer: z.string().nullable(),
  title: z.string().nullable(),
})

/**
 * Hand-written: the API rejects zod's length keywords. Nullable fields are
 * `anyOf: [{type: 'string'}, {type: 'null'}]`, not `type: ['string', 'null']`
 * — the array-of-types shorthand is outside the documented structured-output
 * subset.
 */
export const FRONT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['new_trip', 'faq', 'unclear'] },
    answer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['label', 'answer', 'title'],
  additionalProperties: false,
}

export type FrontDeskDeps = { sql: postgres.Sql; transport: Transport; limits: Limits; now: () => number }

/**
 * Parent spec section 3: a fixed label set via structured output; on any parse
 * failure it routes to planning, never guesses, never drops. Every way the
 * verdict can be unusable — refusal, truncation, bad JSON, wrong shape, a faq
 * with nothing to say, a trip with no title — is the same outcome: 'fallback',
 * which routes to planning without a title. Only a whole verdict is trusted.
 */
export function parseFrontVerdict(result: ModelResult): { label: FrontLabel; answer: string | null; title: string | null } {
  const fallback = { label: 'fallback' as const, answer: null, title: null }
  if (result.kind === 'refused' || result.stopReason !== 'end_turn') return fallback
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fallback }
  const parsed = Verdict.safeParse(raw)
  if (!parsed.success) return fallback
  const v = parsed.data
  if (v.label === 'faq') {
    if (v.answer === null || v.answer.trim().length === 0) return fallback
    return { label: 'faq', answer: maskControlChars(v.answer), title: null }
  }
  if (v.label === 'new_trip') {
    if (v.title === null || v.title.trim().length === 0) return fallback
    return { label: 'new_trip', answer: null, title: maskControlChars(v.title).slice(0, 120) }
  }
  return { label: 'unclear', answer: null, title: null }
}

export function makeFrontDesk(deps: FrontDeskDeps): Agent {
  return async (ctx: AgentContext): Promise<AgentStep> => {
    const { sql } = deps
    const seat = SEATS.front_desk
    const args: CallArgs = {
      seat, system: SYSTEM, tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: lastUserText(ctx) }] }],
      outputSchema: FRONT_SCHEMA,
    }
    const inputTokens = deps.transport.countTokens
      ? (await deps.transport.countTokens(buildCountTokensRequest(args))).input_tokens
      : estimateInputTokens(args)
    const reserved = estimateMicros(seat, inputTokens)
    const { conversationMicros, dailyMicros, day } = await reserve(sql, { userId: ctx.userId, conversationId: ctx.conversationId, micros: reserved })
    const refund = () => reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual: 0n, day })
    const reached = firstCeilingReached({ conversationMicros, dailyMicros }, deps.limits)
    if (reached !== null) {
      await refund()
      return { kind: 'fail', reason: 'limit_reached', recordedMicros: 0n,
        message: reached === 'conversation'
          ? 'This conversation has reached its spending limit, so I have stopped here rather than run up more. Start a new conversation and I will pick up from what we agreed.'
          : 'We have reached today’s spending limit, so I have stopped here rather than run up more. Come back tomorrow and I will pick up from what we agreed.' }
    }
    let result: ModelResult
    try { result = await callModel(deps.transport, args, deps.now) }
    catch (err) { if (classifyError(err).billed === 'no') await refund(); throw err }
    const actual = result.kind === 'refused' ? 0n : costMicros(seat.model, result.usage, SYSTEM_CACHE_TTL)
    await reconcile(sql, { userId: ctx.userId, conversationId: ctx.conversationId, reserved, actual, day })
    await recordModelCall(sql, { conversationId: ctx.conversationId, turnId: ctx.turnId, userId: ctx.userId,
      seat: 'front_desk', seatConfig: seat, result, systemPrompt: SYSTEM, userPrompt: lastUserText(ctx),
      requestShape: buildRequest(args), thinkingMode: null, costMicros: actual })

    const v = parseFrontVerdict(result)
    if (v.label === 'faq') {
      await recordFrontLabel(sql, { conversationId: ctx.conversationId, userId: ctx.userId, label: 'faq' })
      return { kind: 'park', message: v.answer!, costMicros: 0n, recordedMicros: actual }
    }
    await routeToPlanning(sql, { conversationId: ctx.conversationId, userId: ctx.userId, title: v.title, label: v.label })
    return { kind: 'continue', costMicros: 0n, recordedMicros: actual }
  }
}

function lastUserText(ctx: AgentContext): string {
  for (let i = ctx.state.messages.length - 1; i >= 0; i--) {
    const m = ctx.state.messages[i]!
    if (m.role !== 'user') continue
    const t = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    if (t.length > 0) return t
  }
  return ''
}
