/**
 * The transcript, in the shape a provider actually accepts.
 *
 * THERE IS NO `'tool'` ROLE. An Anthropic transcript carries a tool result as a
 * `tool_result` block inside a USER message, referencing by `tool_use_id` the
 * `id` of the `tool_use` block in the preceding ASSISTANT message. Two things
 * die if this is flattened to a string, which is what this type was until this
 * lesson:
 *
 *  - the `tool_use` id and its structured `input`. Without the id, a result
 *    cannot be paired with the call it answers, and an unpaired `tool_result`
 *    is a 400 on the next request rather than a degraded answer.
 *  - a `thinking` block's `signature`. Extended thinking must be echoed back to
 *    the same model byte for byte across a multi-step loop, and a stringified
 *    thinking block is rejected.
 *
 * `course.turns.state` has been `jsonb` since lesson 2.1, so widening this
 * needed no migration. What it does need is that every block survives a round
 * trip unchanged, which test/engine.test.ts pins twice: block by block through
 * `JSON.parse(JSON.stringify(...))`, which is the encoding, and then through
 * `course.turns.state` itself, writing with `saveTurnState` and reading the
 * column back, because the column is where a resumed turn reads its transcript
 * from and an encoding that survives in memory proves nothing about the
 * parameter cast and the driver on the way there.
 */
export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
export type ToolResultBlock = {
  type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean
}
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock

/** One line of a turn's transcript, as the harness stores it and as the API takes it. */
export type LoopMessage = { role: 'user' | 'assistant'; content: ContentBlock[] }

/**
 * What the harness knows about a turn in progress, and the whole of what a fresh
 * worker gets when it resumes one. From this lesson `messages` is the model's
 * own transcript rather than a paraphrase of it, so a worker that picks up a
 * released turn sends the conversation the previous worker was having instead
 * of starting a new one.
 */
export type TurnState = { step: number; messages: LoopMessage[] }

/** Every text block of a message, joined. Tool blocks and thinking blocks are not text. */
export function textOfBlocks(content: ContentBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
}

/**
 * Every terminal state a turn can be recorded in, as one array rather than a
 * hand-copied list, so lesson 2.7's `turns.fail_reason` check constraint and
 * test/schema.test.ts import this instead of retyping it: a twelfth reason
 * added here and nowhere else now fails that test, not just an insert at 3am.
 *
 * The last three arrived with the error classifier in lesson 1.5. `refused` is
 * the failure that returns HTTP 200. `provider_rejected` is the permanent
 * request fault that must never be retried, split out from `provider_down` so
 * that "try again" and "an operator must fix something" stop being the same
 * word. `unclassified` is an error we could not name, which is deliberately not
 * disguised as a provider outage.
 */
// 'fenced' and 'ambiguous_tool_call' are both from src/repo/toolCalls.ts's
// world but stay two entries, not one: 'fenced' is another worker's claim
// winning cleanly, which needs no attention because that worker is alive and
// will finish the turn; 'ambiguous_tool_call' is a tool that ran and could
// not be recorded, which has an unknown effect outside the system and needs a
// person, the opposite response.
export const FAIL_REASONS = [
  'provider_down', 'fetch_failed', 'limit_reached', 'step_cap',
  'deadline_exceeded', 'crash_loop', 'fenced', 'ambiguous_tool_call', 'stalled',
  'refused', 'provider_rejected', 'unclassified',
] as const

export type FailReason = (typeof FAIL_REASONS)[number]

/**
 * Narrows any `Outcome` (src/loop.ts) to a `FailReason`: everything but
 * `'done'`, `'max_tokens'` and `'continue_later'` is one. `failTurn`'s
 * caller (netlify/functions/run-turn-background.mts) uses this to decide what
 * to write to `turns.fail_reason`, so a reason added to `FAIL_REASONS` is
 * recorded there without that call site needing to know its name.
 */
export function isFailReason(outcome: string): outcome is FailReason {
  return (FAIL_REASONS as readonly string[]).includes(outcome)
}

export type Limits = {
  conversationCeilingMicros: bigint
  dailyCeilingMicros: bigint
  globalCeilingMicros: bigint
  maxSteps: number
  /**
   * How many SUPPLIER calls one turn may make, counted from the rows
   * `ledgerRunner` writes BEFORE each call (`countSupplierCalls`,
   * src/tools/supplierBudget.ts), so an attempt that died mid flight still
   * counts. Supplier calls rather than tool calls, and it is not the same
   * number: one `research_destination` row is up to three hotel searches, which
   * is why `SUPPLIER_CALL_COST` prices a row rather than counting it. A step cap is not a supplier cap: a turn that never proposes can
   * spend every step it has on searches, and a supplier is rate limited and
   * sometimes metered whether or not the turn ends well.
   */
  maxSupplierCallsPerTurn: number
}

/**
 * Current spend against each of the three ceilings in `Limits`. Named and
 * exported rather than left inline in `DecideInput` so that lesson 2.6's reader
 * can declare it as its return type: one definition means the reader and the
 * decider cannot drift apart silently.
 */
export type Spend = {
  conversationMicros: bigint
  dailyMicros: bigint
  globalMicros: bigint
}

export type DecideInput = {
  state: TurnState
  spend: Spend
  limits: Limits
  nowMs: number
  deadlineMs: number
  estStepMs: number
  /**
   * Something she typed while this turn was still working. Accepted and still
   * not read: both callers pass null (src/worker.ts, src/loop.ts) and module 3
   * ended without a use for it, so a message she types mid-turn is answered by
   * the next turn, exactly as it was before this field existed. It is in the
   * input so the shape does not change under the callers when something built
   * after this course ends gives a running turn a way to pick it up.
   */
  pendingUserMessage: string | null
}

export type Decision =
  | { kind: 'call_model' }
  | { kind: 'park'; message: string }
  | { kind: 'stop'; reason: FailReason }
  | { kind: 'continue_later' }

/**
 * Is any of the three ceilings reached? The money predicate, in one place.
 *
 * Greater-or-equal, not greater: the ceiling is reached at the limit, not one
 * micro past it. Both callers' tests pin both sides of that boundary.
 *
 * Which of the three fired is deliberately not returned here: both call sites
 * that decide whether to stop only ever needed the boolean. `whichCeiling`
 * below answers the question separately, for the one caller that does need a
 * name: the sentence she reads on a capped turn (src/limit-message.ts).
 */
export function exceedsAnyCeiling(spend: Spend, limits: Limits): boolean {
  // Global first because it is the only ceiling protecting the account rather
  // than one user, the one cap that can fire while both per-user counters read
  // zero. With a boolean result the order is not observable; it is kept because
  // it is the order that reads correctly.
  return spend.globalMicros >= limits.globalCeilingMicros
      || spend.conversationMicros >= limits.conversationCeilingMicros
      || spend.dailyMicros >= limits.dailyCeilingMicros
}

/**
 * Which ceiling exceedsAnyCeiling found reached, in the same order and with
 * the same boundary. Null when none is: a caller that already knows
 * exceedsAnyCeiling returned true never sees it, but the type says so anyway
 * rather than asserting it.
 */
export function whichCeiling(spend: Spend, limits: Limits): 'account' | 'conversation' | 'daily' | null {
  if (spend.globalMicros >= limits.globalCeilingMicros) return 'account'
  if (spend.conversationMicros >= limits.conversationCeilingMicros) return 'conversation'
  if (spend.dailyMicros >= limits.dailyCeilingMicros) return 'daily'
  return null
}

/**
 * The whole decision, as a pure function of numbers. No clock of its own, no
 * database, no client: the shell hands in `nowMs`, which is why the tests above
 * need no mocks at all.
 */
export function decideNext(input: DecideInput): Decision {
  const { state, spend, limits, nowMs, deadlineMs, estStepMs } = input

  // Money first: a ceiling beats every other consideration.
  if (exceedsAnyCeiling(spend, limits)) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (state.step >= limits.maxSteps) {
    return { kind: 'stop', reason: 'step_cap' }
  }
  // Wall clock: hand off to a fresh invocation rather than be killed mid step.
  if (nowMs + estStepMs >= deadlineMs) {
    return { kind: 'continue_later' }
  }
  return { kind: 'call_model' }
}
