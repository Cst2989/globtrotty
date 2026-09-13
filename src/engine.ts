/**
 * The transcript, in the shape a provider actually accepts.
 *
 * THERE IS NO `'tool'` ROLE. An Anthropic transcript carries a tool result as a
 * `tool_result` block inside a **user** message, referencing by `tool_use_id`
 * the `id` of the `tool_use` block in the preceding **assistant** message. Two
 * things die if this is flattened to a string, as it was before:
 *
 *  - the `tool_use` id and its structured `input`. Without the id, a result
 *    cannot be paired with the call it answers, and an unpaired `tool_result`
 *    is a 400 on the next request rather than a degraded answer.
 *  - a `thinking` block's `signature`. Extended thinking must be echoed back to
 *    the same model byte-for-byte across a multi-step loop; a stringified
 *    thinking block is rejected.
 *
 * `turns.state` is already `jsonb`, so widening this needed no migration — but
 * it does mean every block here must survive a JSON round trip unchanged, which
 * test/engine.test.ts pins.
 */
export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string }
export type ToolResultBlock = {
  type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean
}
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock

export type LoopMessage = { role: 'user' | 'assistant'; content: ContentBlock[] }

export type TurnState = { step: number; messages: LoopMessage[] }

/**
 * Every terminal state a turn can be recorded in. Mirrored exactly by the
 * `turns.fail_reason` check constraint (supabase/migrations/0010) -- the type and
 * the constraint are pinned against each other, in both directions, by
 * test/schema.test.ts.
 *
 * The last three arrived with the classifier (src/errors.ts, T0.2). `refused` is
 * the failure that returns HTTP 200; `provider_rejected` is the permanent request
 * fault that must never be retried, split out from `provider_down` so "try again"
 * and "an operator must fix something" stop being the same word; `unclassified` is
 * an error we could not name, which is deliberately not disguised as a provider
 * outage. See src/errors.ts for why each exists.
 */
export type FailReason =
  | 'provider_down' | 'fetch_failed' | 'limit_reached' | 'step_cap'
  | 'deadline_exceeded' | 'crash_loop' | 'fenced' | 'stalled'
  | 'refused' | 'provider_rejected' | 'unclassified'

export type Limits = {
  conversationCeilingMicros: bigint
  dailyCeilingMicros: bigint
  globalCeilingMicros: bigint
  maxSteps: number
  maxSupplierCallsPerTurn: number
}

/**
 * Current spend, as read by `readSpendFailClosed`, against each of the three
 * ceilings in `Limits`. Named and exported rather than left inline inside
 * `DecideInput` so `src/repo/spend.ts` can declare it as its return type: one
 * definition means the reader and the decider cannot drift apart silently.
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
  pendingUserMessage: string | null
}

export type Decision =
  | { kind: 'call_model' }
  | { kind: 'park'; message: string }
  | { kind: 'stop'; reason: FailReason }
  | { kind: 'continue_later' }

/**
 * Which ceiling is reached, in ONE place — the money predicate, checked in the
 * order the account-level cap must win: global (the only ceiling protecting the
 * ACCOUNT rather than one user — the one cap that can fire while both per-user
 * counters read zero), then conversation, then daily.
 *
 * `Partial<Spend>` rather than `Spend`: `src/agents/driver.ts` calls this with
 * only `conversationMicros`/`dailyMicros` — `reserve()` (src/repo/reservation.ts)
 * never reads the global counter, and `decideNext` already checked all three
 * from `readSpendFailClosed` before the driver runs. A field the caller did not
 * supply is skipped, never treated as zero.
 *
 * Three tiers used to ask "is any ceiling reached" as three independent copies
 * of the same `>=` comparisons: `decideNext` below, `submitMessage`
 * (src/handler.ts) before a turn is even queued, and the driver, which also
 * needs to know WHICH one fired to pick the right message for her. Three
 * copies is exactly what `DEFAULT_LIMITS`' own doc comment argues against for
 * the constants, and for the same reason: consumers disagreeing about a money
 * limit means one of them silently is not enforcing what the others think it
 * is. Duplicating the comparisons re-opens that hole one level up from the
 * numbers, where a typo'd field pair (`dailyMicros >= globalCeilingMicros`)
 * type-checks fine — which is exactly the shape the driver's own hand-copied
 * pair used to be, before it was routed through this function too.
 *
 * `>=`, not `>`: the ceiling is reached AT the limit, not one micro past it.
 * Every consumer's tests pin both sides of that boundary.
 */
export function firstCeilingReached(
  spend: Partial<Spend>, limits: Limits,
): 'global' | 'conversation' | 'daily' | null {
  if (spend.globalMicros !== undefined && spend.globalMicros >= limits.globalCeilingMicros) {
    return 'global'
  }
  if (
    spend.conversationMicros !== undefined
    && spend.conversationMicros >= limits.conversationCeilingMicros
  ) {
    return 'conversation'
  }
  if (spend.dailyMicros !== undefined && spend.dailyMicros >= limits.dailyCeilingMicros) {
    return 'daily'
  }
  return null
}

/**
 * "Is any of the three ceilings reached?" — `decideNext` below and
 * `submitMessage` (src/handler.ts) only need the boolean, not which one fired,
 * so this stays their entry point rather than making both compare
 * `firstCeilingReached(...) !== null` themselves.
 *
 * Which of the three fired is deliberately not returned from HERE. All three
 * produce the identical outcome at both call sites, so a discriminator would
 * be a value nothing at either site reads and no test could pin — unlike the
 * driver, which does read it (see `firstCeilingReached` above).
 */
export function exceedsAnyCeiling(spend: Spend, limits: Limits): boolean {
  return firstCeilingReached(spend, limits) !== null
}

export function decideNext(input: DecideInput): Decision {
  const { state, spend, limits, nowMs, deadlineMs, estStepMs } = input

  // Money first: a ceiling beats every other consideration. Note honestly that
  // all three ceilings return the identical decision, so their relative order is
  // not observable from outside and no test can pin it (the brief's `detail`
  // discriminator, which would have made it observable, contradicted its own
  // assertions and is deliberately not added). What IS pinned by test is that
  // all three beat the step cap and the deadline below.
  if (exceedsAnyCeiling(spend, limits)) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (state.step >= limits.maxSteps) {
    return { kind: 'stop', reason: 'step_cap' }
  }
  // Wall clock: hand off to a fresh invocation rather than be killed mid-step.
  if (nowMs + estStepMs >= deadlineMs) {
    return { kind: 'continue_later' }
  }
  return { kind: 'call_model' }
}
