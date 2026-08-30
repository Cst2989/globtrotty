import type postgres from 'postgres'
import type { Seat, SeatName } from '../model/seats.js'
import type { ModelResult } from '../model/client.js'

export type CapturePolicy = 'full' | 'truncated' | 'sampled_out'

/** Above this, a cheap seat's prompts are truncated rather than stored whole. */
const TRUNCATE_ABOVE_BYTES = 8_192

/**
 * Spec section 7 fixes this policy rather than leaving it to a sampling rate:
 * `driver` and `front_desk` are ALWAYS `full` and never sampled, because they
 * are the eval corpus part 3 reads and the fine-tuning corpus part 4 reads —
 * a sampled-out driver row is a hole in both. `reviewer` is full for the same
 * reason. The cheap, high-volume seats truncate above 8KB.
 */
export function capturePolicyFor(
  seat: SeatName, systemBytes: number, userBytes: number,
): CapturePolicy {
  if (seat === 'driver' || seat === 'front_desk' || seat === 'reviewer') return 'full'
  return systemBytes + userBytes > TRUNCATE_ABOVE_BYTES ? 'truncated' : 'full'
}

/**
 * Spec section 7: "credentials cannot enter, enforced by an allowlist test."
 *
 * Prompts carry tool results, and a tool result is text we merely paid for — a
 * supplier error body can echo a URL with an embedded password. This runs on
 * everything written to the ledger.
 *
 * Patterns are deliberately broad: over-redacting a trace costs a little
 * debuggability, under-redacting writes a live credential to a table with a
 * 90-day retention.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,                       // Anthropic keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,            // bearer tokens
  /\bBasic\s+[A-Za-z0-9+/]{8,}=*/gi,                 // basic auth
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,   // user:password@host in any URL
  /\b(api[_-]?key|apikey|access[_-]?token|secret)\b\s*[=:]\s*"?[A-Za-z0-9._~+/-]{8,}"?/gi,
]

export function redactCredentials(text: string): string {
  let out = text
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

const MAX_STORED = 64_000

/**
 * Appends one row to the cost ledger. BEST EFFORT: a failure here is swallowed
 * and logged, never propagated.
 *
 * That asymmetry is deliberate and is the one spec section 7 calls out: the span
 * is best-effort, the SPEND is not. `reserve`/`reconcile` (src/repo/reservation.ts)
 * enforce money and must fail the turn if they cannot write. If both shared an
 * error path, a degraded database during a runaway loop would swallow the
 * guardrail in exactly the failure mode it exists for.
 */
export async function recordModelCall(
  sql: postgres.Sql,
  args: {
    conversationId: string | null
    turnId: string | null
    userId: string
    seat: SeatName
    seatConfig: Seat
    result: ModelResult
    systemPrompt: string
    userPrompt: string
    /**
     * The request exactly as assembled for this call (`buildRequest`'s return),
     * before redaction. Spec section 7's drift clause: "We also record the full
     * request shape, because a silent provider-side change to a default is now
     * as likely a drift vector as a weights change." Written only when
     * `capturePolicyFor` returns `'full'` — see the `redactedRequest` comment
     * below for why the cheap seats' truncated/sampled-out rows store NULL
     * instead of a second copy of the same request.
     */
    requestShape: unknown
    /** What we asked the provider to do about thinking, e.g. 'adaptive'. */
    thinkingMode: string | null
    costMicros: bigint
  },
): Promise<void> {
  try {
    const system = redactCredentials(args.systemPrompt)
    const user = redactCredentials(args.userPrompt)
    // UTF-8 BYTES, not `.length` (UTF-16 code units) — `capturePolicyFor`'s
    // parameters are named `systemBytes`/`userBytes` and the 8KB truncation
    // threshold is a byte count. A code-unit count undercounts multi-byte text
    // (CJK, emoji) by up to ~3x, which is exactly how estimateInputTokens's own
    // earlier bug happened (src/model/client.ts).
    const policy = capturePolicyFor(
      args.seat, Buffer.byteLength(system, 'utf8'), Buffer.byteLength(user, 'utf8'),
    )
    const clip = (s: string) => (policy === 'truncated' ? s.slice(0, MAX_STORED) : s)

    const r = args.result
    const response = r.kind === 'refused'
      ? { stop_reason: 'refusal', stop_details: { category: r.category, explanation: r.explanation } }
      : { stop_reason: r.stopReason, content: r.content }
    // Redact, then parse BACK to an object. `sql.json(<a string>)` stores a jsonb
    // STRING SCALAR, and `response->>'stop_reason'` on a string scalar is null
    // forever. Redacting before serialising is still what stops a credential
    // inside a nested content block from slipping through.
    const redactedResponse: unknown = JSON.parse(redactCredentials(JSON.stringify(response)))

    // Same redact-then-reparse as `response` above, and for the same two
    // reasons: `sql.json(<a string>)` stores a jsonb string scalar, which makes
    // `request_shape->>'model'` null forever; and redacting before serialising
    // is what stops a credential nested inside a message content block.
    //
    // Written only when `policy === 'full'`: driver/front_desk/reviewer, plus
    // any cheap seat that happens to land under the truncation threshold. A
    // truncated or (should the policy ever produce it) sampled-out row stores
    // NULL rather than a second copy of the request — it is the largest thing
    // in the row, and 'truncated' exists precisely to stop storing large things.
    // The column has no NOT NULL constraint and its check constraint still
    // admits 'sampled_out', so a future sampler must keep writing NULL here
    // rather than silently start leaking requests.
    const redactedRequest: unknown = policy === 'full'
      ? JSON.parse(redactCredentials(JSON.stringify(args.requestShape)))
      : null

    await sql.begin(async (tx) => {
      await tx`
        insert into model_calls (
          conversation_id, turn_id, user_id, seat, prompt_version, model_config_id,
          effort, thinking_mode, max_tokens, model, request_id, system_prompt,
          user_prompt, response, request_shape,
          input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          output_tokens, cost_micros, latency_ms, capture_policy
        ) values (
          ${args.conversationId}, ${args.turnId}, ${args.userId}, ${args.seat},
          ${args.seatConfig.promptVersion}, ${args.seatConfig.modelConfigId},
          ${args.seatConfig.effort}, ${args.thinkingMode},
          ${args.seatConfig.maxTokens}, ${r.model},
          ${r.requestId}, ${clip(system)}, ${clip(user)},
          ${sql.json(redactedResponse as never)},
          ${redactedRequest === null ? null : sql.json(redactedRequest as never)},
          ${r.usage.input_tokens}, ${r.usage.cache_creation_input_tokens},
          ${r.usage.cache_read_input_tokens}, ${r.usage.output_tokens},
          ${args.costMicros.toString()}, ${r.latencyMs}, ${policy}
        )`
    })
  } catch (err) {
    // Swallowed, but never silently: a missing trace must be distinguishable
    // from a dropped one, and the log line is the only remaining evidence.
    console.error('recordModelCall: trace write failed', {
      seat: args.seat, conversationId: args.conversationId, err,
    })
  }
}
