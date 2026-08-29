// Types only, erased at compile time — see the note in src/errors.ts for why the
// SDK dependency is worth taking here too: `RefusalStopDetails['category']` is
// the SDK's real five-literal union, so a hand-rolled `string | null` here can't
// silently drift from what `isRefusal`/`RefusalError` are typed against.
import type { RefusalStopDetails, StopReason } from '@anthropic-ai/sdk/resources/messages'
import type { ContentBlock, LoopMessage } from '../engine.js'
import { isRefusal } from '../errors.js'
import { cacheableSystem, placeBreakpoints } from './cache.js'
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
  /**
   * `options` mirrors the real SDK's `messages.create(params, options)` second
   * argument (`RequestOptions`, which carries `signal`) rather than folding the
   * abort signal into `req`: `req` is exactly the JSON body `buildRequest`
   * assembles, and `signal` is a transport-level concern that was never part of
   * that body on the wire.
   */
  create: (req: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  countTokens?: (req: unknown) => Promise<{ input_tokens: number }>
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

  const head = cacheableSystem(system, tools)
  const req: Record<string, unknown> = {
    model: seat.model,
    max_tokens: seat.maxTokens,
    system: head.system,
    // Breakpoints FIRST, suffix second: the volatile notebook must land after
    // the rolling breakpoint, never carry it.
    messages: withSuffix(placeBreakpoints(messages), args.suffix),
    thinking: { type: 'adaptive' },
  }
  if (head.tools.length > 0) req.tools = head.tools
  if (Object.keys(outputConfig).length > 0) req.output_config = outputConfig
  return req
}

/** Shallow copy of `obj` with `key` dropped. */
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...obj }
  delete rest[key]
  return rest
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
  return omit(buildRequest(args), 'max_tokens')
}

/**
 * Bytes per token. UTF-8 BYTES, not `.length` (UTF-16 code units): a CJK
 * character is ~1 token but 3 bytes and 1 code unit, so dividing `.length` by 3
 * (as an earlier version of this function did) undercounted CJK input by roughly
 * 3x — measured, not assumed. At 3 bytes/token, CJK lands close to its real
 * ~1 token/char, and English (~4 bytes/token in practice) over-reserves by
 * 15-30%. That is the direction a guardrail is allowed to be wrong in.
 */
const BYTES_PER_TOKEN = 3

/**
 * The fallback when a transport offers no `countTokens`.
 *
 * DERIVED FROM `buildRequest`, not from `args` directly — an earlier version of
 * this function read `args.system`/`args.messages`/`args.tools` and skipped
 * `args.suffix` entirely. The suffix is the notebook and memory (spec §7's
 * volatile, uncached context), routinely the largest block in the prompt, and
 * it grows every turn — so that version's undercount was unbounded, not a fixed
 * offset. `buildRequest` is the single place the suffix gets folded into the
 * transcript (via `withSuffix`); counting anything else is exactly the mistake
 * `buildCountTokensRequest`'s doc comment above warns against: "a reservation
 * computed from a different prompt than the one dispatched is not a bound on
 * anything."
 *
 * Biased HIGH and rounded UP: this number feeds the reservation, which is the
 * guardrail's ceiling. Over-estimating costs a larger refund at reconcile;
 * under-estimating lifts the ceiling for exactly the call it was supposed to
 * bound. Only one of those two errors is recoverable.
 */
export function estimateInputTokens(args: CallArgs): number {
  const bytes = Buffer.byteLength(JSON.stringify(buildRequest(args)), 'utf8')
  return Math.ceil(bytes / BYTES_PER_TOKEN)
}

type RawResponse = {
  content?: ContentBlock[]
  stop_reason?: StopReason | null
  stop_details?: RefusalStopDetails | null
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
  const raw = (await transport.create(buildRequest(args), { signal: args.signal })) as RawResponse
  const latencyMs = Math.max(0, now() - started)
  const model = raw.model ?? args.seat.model
  const requestId = raw._request_id ?? null

  // The SDK guarantees a non-null stop_reason in non-streaming mode
  // (messages.d.ts: "In non-streaming mode this value is always non-null").
  // Its absence here means the `as RawResponse` cast above is wrong for this
  // response — a wrapped shape, a `.withResponse()` object, a future rename —
  // and that is exactly the situation this module exists to never paper over.
  // Defaulting to 'end_turn' would turn an unrecognized shape (which may well
  // BE a refusal we failed to parse) into a confident, silent false success.
  // Fail loud instead: throw, and let the transport-error path above the
  // module handle it exactly like any other malformed response.
  if (raw.stop_reason == null) {
    throw new Error(
      `callModel: response has no stop_reason (${JSON.stringify(raw.stop_reason)}). ` +
        "Refusing to default it to 'end_turn' — non-streaming responses guarantee " +
        'this field, so its absence means the response shape was not what we expected.',
    )
  }

  // Mirrors the `stop_reason` guard immediately above, and is placed AFTER it
  // deliberately: `usage` is the one field on this response that is MONEY, and
  // `raw.usage ?? ZERO_USAGE` used to default it to zero. A malformed or
  // wrapped response with no `usage` would then price at `0n`, `reconcile`
  // (src/repo/reservation.ts) would refund the WHOLE reservation, and a real,
  // billed call would record as free — silently, with nothing red anywhere.
  // Ordered after `stop_reason` rather than before it so a response missing
  // BOTH fields is reported by the more specific, already-established error
  // first; ordered before the `isRefusal` branch below so a genuine refusal
  // (which the SDK always returns `usage` for) is still classified correctly —
  // this guard only ever fires on a response shape neither branch expected.
  if (raw.usage == null) {
    throw new Error(
      `callModel: response has no usage (${JSON.stringify(raw.usage)}). Refusing to ` +
        'default it to zero — usage is the field this whole ledger is priced from, ' +
        'and a missing one would record a real, billed call as free.',
    )
  }
  const usage = raw.usage

  // Checked BEFORE content is touched. This ordering is the whole contract, and
  // it is delegated to src/errors.ts's `isRefusal` rather than re-implemented
  // here so there is exactly one definition of "this is a refusal" in the repo.
  // A refusal can carry a non-empty `content` (the SDK's own docs: streaming
  // classifiers may intervene mid-response, after text was already generated),
  // so this check must never be reached by first inspecting `content.length`.
  if (isRefusal({ stop_reason: raw.stop_reason, stop_details: raw.stop_details ?? null })) {
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
    stopReason: raw.stop_reason,
    model, requestId, usage, latencyMs,
  }
}
