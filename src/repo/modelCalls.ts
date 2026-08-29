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
    /** What we asked the provider to do about thinking, e.g. 'adaptive'. */
    thinkingMode: string | null
    costMicros: bigint
  },
): Promise<void> {
  try {
    const system = redactCredentials(args.systemPrompt)
    const user = redactCredentials(args.userPrompt)
    const policy = capturePolicyFor(args.seat, system.length, user.length)
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

    await sql.begin(async (tx) => {
      await tx`
        insert into model_calls (
          conversation_id, turn_id, user_id, seat, prompt_version, model_config_id,
          effort, thinking_mode, max_tokens, model, request_id, system_prompt,
          user_prompt, response,
          input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
          output_tokens, cost_micros, latency_ms, capture_policy
        ) values (
          ${args.conversationId}, ${args.turnId}, ${args.userId}, ${args.seat},
          ${args.seatConfig.promptVersion}, ${args.seatConfig.modelConfigId},
          ${args.seatConfig.effort}, ${args.thinkingMode},
          ${args.seatConfig.maxTokens}, ${r.model},
          ${r.requestId}, ${clip(system)}, ${clip(user)},
          ${sql.json(redactedResponse as never)},
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
