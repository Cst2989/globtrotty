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

export type DecideInput = {
  state: TurnState
  spend: { conversationMicros: bigint; dailyMicros: bigint }
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
