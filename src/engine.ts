export type LoopMessage = { role: 'user' | 'assistant' | 'tool'; content: string }

export type TurnState = { step: number; messages: LoopMessage[]; reviewRounds: number }

export type FailReason =
  | 'provider_down' | 'fetch_failed' | 'limit_reached' | 'step_cap'
  | 'deadline_exceeded' | 'crash_loop' | 'fenced' | 'stalled'

export type Limits = {
  conversationCeilingMicros: bigint
  dailyCeilingMicros: bigint
  globalCeilingMicros: bigint
  maxSteps: number
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

export function decideNext(input: DecideInput): Decision {
  const { state, spend, limits, nowMs, deadlineMs, estStepMs } = input

  // Money first: a ceiling beats every other consideration.
  //
  // Global comes first of the three because it is the only ceiling protecting the
  // ACCOUNT rather than one user — a runaway that has exhausted the account is not
  // a per-conversation problem, and it is the one cap that can fire while both
  // per-user counters read zero. Note honestly that all three return the identical
  // decision, so this ordering is not observable from outside and no test can pin
  // it (the brief's `detail` discriminator, which would have made it observable,
  // contradicted its own assertions and is deliberately not added). What IS pinned
  // by test is that all three beat the step cap and the deadline below.
  if (spend.globalMicros >= limits.globalCeilingMicros) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (spend.conversationMicros >= limits.conversationCeilingMicros) {
    return { kind: 'stop', reason: 'limit_reached' }
  }
  if (spend.dailyMicros >= limits.dailyCeilingMicros) {
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
