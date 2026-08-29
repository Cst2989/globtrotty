import type { ContentBlock, LoopMessage } from '../engine.js'
import type { Seat } from './seats.js'

export type ModelUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/**
 * Deliberately a discriminated union rather than one shape with an optional
 * refusal field.
 *
 * `stop_reason: 'refusal'` is an HTTP 200 with a populated `stop_details` and a
 * frequently EMPTY `content` array. It does not throw, so a caller that reads
 * `content` first gets a successful-looking turn that produced nothing, hands
 * the user an empty answer, and records no failure. Making the two outcomes
 * different variants turns "forgot to check" from a silent runtime bug into a
 * compile error at every call site.
 */
export type ModelResult =
  | {
      kind: 'ok'; content: ContentBlock[]; stopReason: string; model: string
      requestId: string | null; usage: ModelUsage; latencyMs: number
    }
  | {
      kind: 'refused'; category: string | null; explanation: string | null
      model: string; requestId: string | null; usage: ModelUsage; latencyMs: number
    }

export type CallArgs = {
  seat: Seat
  system: string
  messages: LoopMessage[]
  tools: unknown[]
  /**
   * Volatile context — the notebook, memory — rendered AFTER the last cache
   * breakpoint. Spec section 7: it changes every turn, so anything cached behind
   * it is invalidated on every single request. Kept out of `system` for exactly
   * that reason: `system` is the 1h-TTL prefix, and putting the notebook there
   * would throw the cache away whenever she stated a fact.
   */
  suffix?: string
  signal?: AbortSignal
}

/**
 * Injected so this module is testable with no key and no network.
 *
 * An object rather than a bare function because spec section 8 computes the
 * reservation from `count_tokens` ON THE ASSEMBLED REQUEST, and a single
 * callable has nowhere to put a second endpoint. `countTokens` is optional: a
 * stub transport in a test does not need one, and `estimateInputTokens` below is
 * the specified fallback.
 */
export type Transport = {
  create: (req: unknown) => Promise<unknown>
  countTokens?: (req: unknown) => Promise<{ input_tokens: number }>
}

const ZERO_USAGE: ModelUsage = {
  input_tokens: 0, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 0,
}

/**
 * Appends volatile context (the suffix) after the last block of the transcript,
 * without ever leaving the request ending on an assistant turn.
 *
 * Appended to the last USER turn where there is one: a new trailing user
 * message would be a second consecutive user turn, and appending to an
 * assistant turn would present the notebook as something the model said. When
 * the transcript ends on an assistant turn, a new user turn is opened instead —
 * that also happens to be what keeps the request from prefilling an assistant
 * turn, which is a 400 on Opus 5.
 */
export function withSuffix(messages: LoopMessage[], suffix: string | undefined): LoopMessage[] {
  if (suffix === undefined || suffix.length === 0) return messages
  const block: ContentBlock = { type: 'text', text: suffix }
  const last = messages.at(-1)
  if (last !== undefined && last.role === 'user') {
    return [...messages.slice(0, -1), { ...last, content: [...last.content, block] }]
  }
  return [...messages, { role: 'user', content: [block] }]
}

/**
 * Assembles the request. Separate from `callModel` so a test can assert the
 * SHAPE without a transport — several of the constraints here are things the
 * API rejects with a 400, and a shape test catches them before a live call does.
 *
 * Not sent, deliberately:
 *  - `budget_tokens` — removed on Opus 5, returns 400. Adaptive thinking plus
 *    `output_config.effort` replaces it. The SDK's thinking union still ACCEPTS
 *    the old shape, because it is model-agnostic, so the compiler is no help
 *    here and the shape test is the guard.
 *  - an assistant prefill — returns 400 on Opus 5.
 * `effort` lives INSIDE `output_config`, never at the top level.
 */
export function buildRequest(args: CallArgs): Record<string, unknown> {
  const { seat, system, messages, tools } = args
  const outputConfig: Record<string, unknown> = {}
  if (seat.effort !== null) outputConfig.effort = seat.effort

  const req: Record<string, unknown> = {
    model: seat.model,
    max_tokens: seat.maxTokens,
    system,
    messages: withSuffix(messages, args.suffix),
    thinking: { type: 'adaptive' },
  }
  if (tools.length > 0) req.tools = tools
  if (Object.keys(outputConfig).length > 0) req.output_config = outputConfig
  return req
}

/**
 * The same request, minus `max_tokens`: the counting endpoint is not being asked
 * to produce output and rejects an output ceiling.
 *
 * DERIVED from `buildRequest` rather than assembled independently. Task 6 adds
 * cache breakpoints inside `buildRequest`, and a reservation computed from a
 * different prompt than the one dispatched is not a bound on anything.
 */
export function buildCountTokensRequest(args: CallArgs): Record<string, unknown> {
  const { max_tokens: _unused, ...rest } = buildRequest(args)
  void _unused
  return rest
}

/** Chars per token. Below the ~3.5-4 English average, on purpose — see below. */
const CHARS_PER_TOKEN = 3

/**
 * The fallback when a transport offers no `countTokens`.
 *
 * Biased HIGH and rounded UP in both directions: this number feeds the
 * reservation, which is the guardrail's ceiling. Over-estimating costs a larger
 * refund at reconcile; under-estimating lifts the ceiling for exactly the call
 * it was supposed to bound. Only one of those two errors is recoverable.
 */
export function estimateInputTokens(args: CallArgs): number {
  // Summed per-item rather than `JSON.stringify(args.messages).length` on the
  // whole array: the outer `[]` an empty array still stringifies to would add
  // structural chars that have no tokens behind them, biasing the *floor*
  // (an empty transcript) up rather than biasing every estimate up uniformly.
  const chars =
    args.system.length +
    args.messages.reduce<number>((n, m) => n + JSON.stringify(m).length, 0) +
    args.tools.reduce<number>((n, t) => n + JSON.stringify(t).length, 0)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

type RawResponse = {
  content?: ContentBlock[]
  stop_reason?: string
  stop_details?: { category?: string | null; explanation?: string | null } | null
  model?: string
  _request_id?: string | null
  usage?: ModelUsage
}

/**
 * Calls the model and classifies the outcome. A transport rejection is NOT
 * caught here — `src/errors.ts` owns the taxonomy, and swallowing it would
 * flatten a 429 and a 400 into the same silence.
 */
export async function callModel(
  transport: Transport, args: CallArgs, now: () => number,
): Promise<ModelResult> {
  const started = now()
  const raw = (await transport.create(buildRequest(args))) as RawResponse
  const latencyMs = Math.max(0, now() - started)
  const usage = raw.usage ?? ZERO_USAGE
  const model = raw.model ?? args.seat.model
  const requestId = raw._request_id ?? null

  // Checked BEFORE content is touched. This ordering is the whole contract.
  if (raw.stop_reason === 'refusal') {
    return {
      kind: 'refused',
      category: raw.stop_details?.category ?? null,
      explanation: raw.stop_details?.explanation ?? null,
      model, requestId, usage, latencyMs,
    }
  }
  return {
    kind: 'ok',
    content: raw.content ?? [],
    stopReason: raw.stop_reason ?? 'end_turn',
    model, requestId, usage, latencyMs,
  }
}
