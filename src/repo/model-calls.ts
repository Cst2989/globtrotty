import type postgres from 'postgres'
import type { Usage } from '../pricing.js'
import type { Seat, SeatName } from '../seats.js'

export type CapturePolicy = 'full' | 'truncated' | 'sampled_out'

/** Above this, a cheap seat's prompts are truncated rather than stored whole. */
const TRUNCATE_ABOVE_BYTES = 8_192

/**
 * The most of one PROMPT a truncated row keeps, and prompts are all it covers.
 *
 * `clip` below is applied to `system_prompt` and `user_prompt` and not to
 * `response`, so a truncated row stores its response jsonb whole. Nothing writes
 * such a row today, because the only caller that sends a response is the driver
 * and `capturePolicyFor` holds that seat at `full`, but the limit is named for
 * what it does rather than for what a reader would assume, and the day a cheap
 * seat captures a response is the day this has to grow a second clip.
 *
 * Exported so `test/capture.test.ts` pins the clip against this number rather
 * than against a copy of it, which is what every other limit in this branch
 * does and what this one did not until the number was stated in a docstring and
 * executed by nothing.
 */
export const MAX_STORED = 64_000

/**
 * A fixed policy rather than a sampling rate, for the reason SPEC section 7
 * gives: `driver` and `front_desk` are ALWAYS `full` and never sampled, because
 * they are the corpus module 6's evals read, and a sampled-out driver row is a
 * hole in it. Any other seat truncates above 8KB, because a scout fan-out is
 * three rows per tool call and the volume is the cost.
 *
 * That second branch has no production caller on this branch. The one caller is
 * src/agents/driver.ts, and it passes 'driver' or 'front_desk' every time, so
 * `'truncated'` is returned by nothing a deployed turn runs, `clip` below never
 * clips and `MAX_STORED` bounds nothing yet. The cheap seats do not reach it by
 * another road either: `runScouts` (src/agents/scout.ts) calls `pgSink` with no
 * capture fields at all, so a scout row's `capture_policy`, `system_prompt`,
 * `user_prompt` and `response` are NULL rather than truncated. The rule is
 * written here, exercised by test/capture.test.ts, and waiting for the lesson
 * that captures a cheap seat. README.md carries it as a residual.
 *
 * Main names a third always-full seat, `reviewer`. This branch has no reviewer:
 * `SEATS` has `driver`, `cheap`, `front_desk`, `scout` and `monitor`, and
 * `GATE_NAMES` deliberately leaves `reviewer` out for the same reason, so that
 * the pipeline cannot write a row claiming a reviewer ran. Module 6 adds the
 * seat and adds it here in the same commit; naming it now would be a branch no
 * `SeatName` can reach and a comment describing main rather than this branch.
 *
 * `sampled_out` is in the type and is returned by nothing. The column's check
 * constraint accepts it (migration 0017) so that a sampler added later is a
 * change to this function rather than a change to the schema, and so a reader
 * of the table knows the value is possible.
 */
export function capturePolicyFor(
  seat: SeatName, systemBytes: number, userBytes: number,
): CapturePolicy {
  if (seat === 'driver' || seat === 'front_desk') return 'full'
  return systemBytes + userBytes > TRUNCATE_ABOVE_BYTES ? 'truncated' : 'full'
}

/**
 * SPEC section 7: credentials cannot enter the ledger, enforced by a test that
 * names one case per pattern.
 *
 * Prompts carry tool results, and a tool result is text we merely paid for: a
 * supplier error body can echo a URL with an embedded password. This runs on
 * everything written to the capture columns, inside `pgSink`, rather than at the
 * call sites, because a redaction a caller applies is a redaction the next
 * caller forgets.
 *
 * Patterns are deliberately broad: over-redacting a trace costs a little
 * debuggability, under-redacting writes a live credential to a table module 7
 * keeps for ninety days.
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

/**
 * Everything one model call is worth recording.
 *
 * The eight fields above the line have been here since lesson 2.5, apart from
 * `seatConfig`, which arrived with lesson 5.1's `0014`. The six below it are
 * lesson 5.7's capture, one per column `0017` added, and every one of them is
 * OPTIONAL. That is not laziness about types: `memorySink` and both `pgSink`
 * callers outside src/agents/driver.ts (`runScouts` in src/agents/scout.ts and
 * `ledgerSink` in src/repo/spend.ts) write none of them, and a required field
 * would make a capture nothing else performs into an edit at every one of those
 * sites, each inventing a value for a question it was never asked. What does
 * fill them outside the driver is test/capture.test.ts, which calls `pgSink`
 * directly so the columns are pinned against a real write.
 */
export type CallFacts = {
  seat: SeatName
  /** The seat's own settings, so the row records the configuration we intended. */
  seatConfig: Seat
  promptVersion: string
  /** The model string we sent. */
  modelRequested: string
  /** The model string the API echoed back on the response. */
  modelReturned: string
  usage: Usage
  costMicros: bigint
  latencyMs: number
  /** The provider's own id for the call, for a support conversation about one. */
  requestId?: string | null
  /** What `capturePolicyFor` said about this call, when the caller asked it. */
  capturePolicy?: CapturePolicy
  systemPrompt?: string | null
  userPrompt?: string | null
  /** What we asked the provider to do about thinking, e.g. 'adaptive'. */
  thinkingMode?: string | null
  /** The response, as an object. Redacted and re-parsed below, never a string. */
  response?: unknown
}

/** Who the call was for. Both ids are null when a call runs outside a turn. */
export type TurnContext = {
  userId: string
  conversationId: string | null
  turnId: string | null
}

export type ModelCallSink = (facts: CallFacts) => Promise<void>

/** Writes one row per call. One insert, no transaction: a row is a whole fact. */
export function pgSink(sql: postgres.Sql, ctx: TurnContext): ModelCallSink {
  return async (facts) => {
    try {
      // Redacted HERE and not at the call site, so a caller cannot skip it, and
      // in UTF-8 BYTES rather than `.length`: `capturePolicyFor`'s threshold is
      // a byte count, and a code-unit count undercounts CJK text threefold.
      const system = facts.systemPrompt == null ? null : redactCredentials(facts.systemPrompt)
      const user = facts.userPrompt == null ? null : redactCredentials(facts.userPrompt)
      // Null when nothing was captured at all, which is every caller outside
      // the driver: a row that says 'full' and carries no prompt would describe
      // a capture that never happened. Derived rather than trusted when a
      // prompt IS present and the caller stated no policy, so there is no path
      // to an unclipped prompt.
      const policy: CapturePolicy | null = system === null && user === null
        ? (facts.capturePolicy ?? null)
        : facts.capturePolicy ?? capturePolicyFor(
          facts.seat,
          Buffer.byteLength(system ?? '', 'utf8'),
          Buffer.byteLength(user ?? '', 'utf8'),
        )
      const clip = (s: string | null) =>
        (s !== null && policy === 'truncated' ? s.slice(0, MAX_STORED) : s)
      // Redact, THEN parse back to an object. `sql.json(<a string>)` stores a
      // jsonb STRING SCALAR, and `response->>'stop_reason'` on a string scalar is
      // null forever, so the row would be there and unqueryable. Redacting before
      // serialising is also what stops a credential nested inside a content block
      // from slipping through: a top-level scan of the object would never look
      // inside `content[2].text`.
      const response: unknown = facts.response === undefined
        ? null
        : JSON.parse(redactCredentials(JSON.stringify(facts.response)))

      await sql`insert into course.model_calls (
        conversation_id, turn_id, user_id, seat, prompt_version,
        model_requested, model_returned,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cost_micros, latency_ms,
        effort, max_tokens, model_config_id,
        request_id, capture_policy, thinking_mode, system_prompt, user_prompt, response
      ) values (
        ${ctx.conversationId}, ${ctx.turnId}, ${ctx.userId}, ${facts.seat}, ${facts.promptVersion},
        ${facts.modelRequested}, ${facts.modelReturned},
        ${facts.usage.input_tokens}, ${facts.usage.cache_creation_input_tokens},
        ${facts.usage.cache_read_input_tokens}, ${facts.usage.output_tokens},
        ${facts.costMicros.toString()}, ${facts.latencyMs},
        ${facts.seatConfig.effort}, ${facts.seatConfig.maxTokens}, ${facts.seatConfig.modelConfigId},
        ${facts.requestId ?? null}, ${policy}, ${facts.thinkingMode ?? null},
        ${clip(system)}, ${clip(user)},
        ${response === null ? null : sql.json(response as never)}
      )`
    } catch (err) {
      // The call already happened and she already paid for it: a row that
      // fails to write must not take a finished turn down with it. A lost row
      // is cheaper than a lost turn, and this is still logged with the turn id
      // so an operator can find what broke rather than the loss being silent.
      console.error(`model_calls insert failed for turn ${ctx.turnId}`, err)
    }
  }
}

/** The same sink, in memory, for tests that have no database. */
export function memorySink(): ModelCallSink & { calls: CallFacts[] } {
  const calls: CallFacts[] = []
  const sink = (async (facts: CallFacts) => { calls.push(facts) }) as ModelCallSink & { calls: CallFacts[] }
  sink.calls = calls
  return sink
}
