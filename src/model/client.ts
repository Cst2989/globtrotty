import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient } from '../client.js'
import type { ContentBlock, LoopMessage } from '../engine.js'
import { isRefusal } from '../errors.js'
import { usageOf, type Usage } from '../pricing.js'
import type { Seat } from '../seats.js'

/**
 * Deliberately a discriminated union rather than one shape with an optional
 * refusal field.
 *
 * `stop_reason: 'refusal'` is an HTTP 200 with a populated `stop_details` and a
 * frequently EMPTY `content` array, because a refusal is a classifier stepping
 * in mid generation rather than a block before generation. Nothing throws, so a
 * caller that reads `content` first gets a successful looking turn that
 * produced nothing, hands her an empty answer, and records no failure. Making
 * the two outcomes different variants turns "forgot to check" from a silent
 * runtime bug into a compile error at every call site, which a boolean flag
 * beside the content could never do.
 *
 * `max_tokens` is `kind: 'ok'`. It is a truncation, not a refusal, and the
 * content it did produce is worth showing her.
 */
export type ModelResult =
  | {
      kind: 'ok'; content: ContentBlock[]; stopReason: string; model: string
      requestId: string | null; usage: Usage; latencyMs: number
    }
  | {
      kind: 'refused'; category: string | null; explanation: string | null
      model: string; requestId: string | null; usage: Usage; latencyMs: number
    }

export type CallArgs = {
  seat: Seat
  system: string
  messages: LoopMessage[]
  /**
   * The published tool definitions, as `unknown[]`. The registry (lesson 5.2)
   * produces them from zod and the shape is the API's, not the SDK's `Tool`
   * type, for the same reason `buildRequest` returns a plain object: this is
   * the wire, and the wire is not what the installed types describe.
   */
  tools: unknown[]
  /**
   * Volatile context: the notebook from lesson 5.2, memory from lesson 5.6.
   * Rendered AFTER the last cache breakpoint, because it changes every turn and
   * anything cached behind it would be thrown away on every single request
   * (SPEC section 7). Kept out of `system` for exactly that reason: `system` is
   * the stable prefix, and putting the notebook there would invalidate the cache
   * the moment she states a fact.
   */
  suffix?: string
  signal?: AbortSignal
}

/**
 * Appends volatile context after the last block of the transcript, without ever
 * leaving the request ending on an assistant turn.
 *
 * Appended to the last USER turn where there is one: a new trailing user message
 * would be a second consecutive user turn, and appending to an assistant turn
 * would present the notebook as something the model said. When the transcript
 * ends on an assistant turn a new user turn is opened instead, which is also
 * what keeps the request from prefilling an assistant turn, a 400 on Opus 5.
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
 * Assembles the request, as a plain object rather than as the SDK's
 * `MessageCreateParamsNonStreaming`, and the untyped return is the point.
 *
 * The compiler validates the shape the INSTALLED SDK believes in, which is not
 * the shape the server accepts. `budget_tokens` is the case that proves it: it
 * returns 400 on Opus 5 and it is still a legal member of the SDK's thinking
 * union, so `tsc` is happy about a request that fails every time. A typed
 * builder cannot even express the mistake in a way a test could catch, because
 * the type would be the thing under test. So the assembler is untyped, the cast
 * happens once at the one call site below, and test/request-shape.test.ts reads
 * the object it produced.
 *
 * Not sent, deliberately:
 *  - `budget_tokens`. Removed on Opus 5, returns 400. Adaptive thinking plus
 *    `output_config.effort` replaces it.
 *  - an assistant prefill. Returns 400 on Opus 5, which is why `withSuffix`
 *    opens a new user turn rather than extending a trailing assistant one.
 *  - `temperature`, anywhere in this codebase.
 * `effort` lives INSIDE `output_config`, never at the top level, and is omitted
 * rather than nulled for a seat that has none.
 */
export function buildRequest(args: CallArgs): Record<string, unknown> {
  const { seat, system, messages, tools } = args
  const req: Record<string, unknown> = {
    model: seat.model,
    max_tokens: seat.maxTokens,
    system,
    messages: withSuffix(messages, args.suffix),
    thinking: { type: 'adaptive' },
  }
  if (tools.length > 0) req.tools = tools
  if (seat.effort !== null) req.output_config = { effort: seat.effort }
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
 * DERIVED from `buildRequest` rather than assembled independently. Lesson 5.6
 * adds cache breakpoints inside `buildRequest`, and a reservation computed from
 * a different prompt than the one dispatched is not a bound on anything.
 */
export function buildCountTokensRequest(args: CallArgs): Record<string, unknown> {
  return omit(buildRequest(args), 'max_tokens')
}

/**
 * Bytes per token. UTF-8 BYTES, not `.length`, which counts UTF-16 code units: a
 * CJK character is roughly one token, three bytes and one code unit, so dividing
 * `.length` by three undercounts CJK input by about three times. At three bytes
 * per token CJK lands close to its real rate and English, which runs nearer four
 * bytes per token in practice, over-reserves by fifteen to thirty percent. That
 * is the direction a guardrail is allowed to be wrong in.
 */
const BYTES_PER_TOKEN = 3

/**
 * What we reserve against, when nothing has counted the prompt for us.
 *
 * DERIVED FROM `buildRequest`, not from `args` directly. An estimator that read
 * `args.system`, `args.messages` and `args.tools` would skip `args.suffix`
 * entirely, and the suffix is the notebook and the memory: routinely the largest
 * block in the prompt, and one that grows every turn, so the undercount would be
 * unbounded rather than a fixed offset. `buildRequest` is the single place the
 * suffix is folded into the transcript, so measuring what it produced measures
 * the thing that will actually be sent.
 *
 * Biased HIGH and rounded UP. Over-estimating costs a larger refund at
 * reconcile; under-estimating lifts the ceiling for exactly the call it was
 * supposed to bound, and only one of those two is recoverable.
 */
export function estimateInputTokens(args: CallArgs): number {
  const bytes = Buffer.byteLength(JSON.stringify(buildRequest(args)), 'utf8')
  return Math.ceil(bytes / BYTES_PER_TOKEN)
}

/**
 * Calls the model and classifies the outcome BEFORE anything reads content.
 *
 * The transport stays the branch's typed `ModelClient` (src/client.ts), which is
 * what `replayClient` and `test/model/fake.ts` are written against and what
 * makes `usageOf` and `isRefusal` type-check. Only the request crosses the type
 * boundary, through one cast, in the line below. A transport rejection is NOT
 * caught here: src/errors.ts owns the taxonomy and swallowing it would flatten a
 * 429 and a 400 into the same silence.
 */
export async function callModel(
  client: ModelClient, args: CallArgs, now: () => number,
): Promise<ModelResult> {
  const started = now()
  // The one cast in the module. Everything above it is a plain object the shape
  // test can read; everything below it is the SDK's typed world.
  const raw = await client.create(
    buildRequest(args) as unknown as MessageCreateParamsNonStreaming,
    { signal: args.signal },
  )
  const latencyMs = Math.max(0, now() - started)
  const model = raw.model ?? args.seat.model
  const requestId = (raw as { _request_id?: string | null })._request_id ?? null

  // The SDK guarantees a non-null stop_reason in non-streaming mode. Its absence
  // means the response was not the shape we think it is: a wrapped object, a
  // `.withResponse()` result, a future rename, or a hand-written fixture that
  // forgot the field. Defaulting it to 'end_turn' would turn an unrecognised
  // shape, which may well BE a refusal we failed to parse, into a confident
  // silent success. Fail loud instead, and let the caller's error path treat it
  // like any other malformed response.
  if (raw.stop_reason == null) {
    throw new Error(
      `callModel: response has no stop_reason (${JSON.stringify(raw.stop_reason)}). ` +
      "Refusing to default it to 'end_turn', because a non-streaming response " +
      'guarantees this field and its absence means the shape was not what we expected.',
    )
  }
  // Mirrors the guard above and is placed after it deliberately. `usage` is the
  // one field on this response that is MONEY. A response with no usage would
  // price at 0n, `reconcile` would refund the whole reservation, and a real
  // billed call would record as free, silently, with nothing red anywhere.
  if (raw.usage == null) {
    throw new Error(
      'callModel: response has no usage. Refusing to default it to zero, because ' +
      'usage is the field this whole ledger is priced from and a missing one ' +
      'would record a real, billed call as free.',
    )
  }
  const usage = usageOf(raw)

  // Checked BEFORE content is touched, and delegated to src/errors.ts so there
  // is exactly one definition of "this is a refusal" in the repository. A
  // refusal can carry non-empty content, because the classifier can intervene
  // after text was already generated, so this check must never be reached by
  // first inspecting content.length.
  if (isRefusal(raw)) {
    return {
      kind: 'refused',
      category: raw.stop_details?.category ?? null,
      explanation: raw.stop_details?.explanation ?? null,
      model, requestId, usage, latencyMs,
    }
  }
  return {
    kind: 'ok',
    // The SDK's blocks carry fields our own ContentBlock union does not name
    // (`citations` on text, `caller` on tool_use). They ride along through the
    // jsonb column unchanged, which is what the API wants for a thinking block
    // and harmless for the rest; the union names what we READ.
    content: raw.content as unknown as ContentBlock[],
    stopReason: raw.stop_reason,
    model, requestId, usage, latencyMs,
  }
}
