/** What the harness knows about a turn in progress. Module 3 persists this. */
export type TurnState = { step: number }

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
export const FAIL_REASONS = [
  'provider_down', 'fetch_failed', 'limit_reached', 'step_cap',
  'deadline_exceeded', 'crash_loop', 'fenced', 'stalled',
  'refused', 'provider_rejected', 'unclassified',
] as const

export type FailReason = (typeof FAIL_REASONS)[number]

export type Limits = {
  conversationCeilingMicros: bigint
  dailyCeilingMicros: bigint
  globalCeilingMicros: bigint
  maxSteps: number
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
   * Something she typed while this turn was still working. Accepted and not read
   * yet: module 3 is where a running turn picks it up instead of making her wait
   * for a second turn. It is in the input now so the shape does not change under
   * the callers later.
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
