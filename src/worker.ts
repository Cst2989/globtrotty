import type postgres from 'postgres'
import { decideNext, type Limits, type TurnState, type LoopMessage } from './engine.js'
import {
  claimTurn, saveTurnState, completeTurn, failTurn, heartbeat, releaseForContinuation,
  FencedError, type Claim,
} from './repo/turns.js'
import { recordSpend, readSpendFailClosed } from './repo/spend.js'
import { beginToolCall, finishToolCall } from './repo/toolCalls.js'

export type AgentContext = { state: TurnState; conversationId: string; userId: string }

export type AgentStep =
  | { kind: 'message'; text: string; costMicros: bigint }
  | { kind: 'tool'; callId: string; name: string; run: () => Promise<unknown>; costMicros: bigint }

export type Agent = (ctx: AgentContext) => Promise<AgentStep>

export type WorkerDeps = {
  sql: postgres.Sql
  limits: Limits
  agent: Agent
  now: () => number
  deadlineMs: () => number
  reinvoke: (turnId: string) => Promise<void>
  /**
   * How often to emit a liveness heartbeat while a step is in flight. Defaults to
   * HEARTBEAT_INTERVAL_MS. Tests override this to something short so the behavior
   * can be observed without a real multi-second wait.
   */
  heartbeatIntervalMs?: number
}

const EST_STEP_MS = 60_000
// Well under HEARTBEAT_STALE (90s, src/repo/turns.ts) so a real step — a dozen
// model calls, parallel workers, a 60s Retry-After sleep — keeps refreshing
// heartbeat_at faster than the sweeper's staleness window can close on it.
const HEARTBEAT_INTERVAL_MS = 25_000
const EMPTY: TurnState = { step: 0, messages: [], reviewRounds: 0 }

/** Proves the harness without a model: echoes the last user message back. */
export const echoAgent: Agent = async ({ state }) => {
  const last = [...state.messages].reverse().find((m) => m.role === 'user')
  return {
    kind: 'message',
    text: `You said: ${last?.content ?? '(nothing)'}`,
    costMicros: 1_000n,
  }
}

export async function runTurn(deps: WorkerDeps, turnId: string): Promise<void> {
  const { sql } = deps
  const claim = await claimTurn(sql, turnId)
  if (!claim) return                       // another worker owns it; walk away silently

  try {
    await loop(deps, claim)
  } catch (err) {
    if (err instanceof FencedError) return // superseded: write nothing
    // Accepted limitation (plan 1): every error maps to 'provider_down'. The echo agent
    // cannot produce a real provider error, and the classifier arrives with the model
    // client in a later plan — see progress.md Ruling E.
    await failTurn(sql, claim, 'provider_down').catch(() => {})
    throw err
  }
}

/**
 * Runs `work` while periodically calling heartbeat(sql, claim), so a step that
 * runs long (a dozen model calls, parallel workers, a 60s Retry-After sleep)
 * keeps advancing heartbeat_at and is never mistaken by the sweeper for a dead
 * worker mid-call. If a tick discovers we've been superseded (FencedError), the
 * error is captured and re-thrown once `work` settles — the loop aborts rather
 * than continuing to act on a turn it no longer owns. Any other heartbeat
 * failure is treated as transient and swallowed (the next tick retries), so a
 * tick can never surface as an unhandled rejection.
 */
async function withHeartbeat<T>(
  sql: postgres.Sql, claim: Claim, intervalMs: number, work: () => Promise<T>,
): Promise<T> {
  let fenced: FencedError | null = null
  const timer = setInterval(() => {
    heartbeat(sql, claim).catch((err: unknown) => {
      if (err instanceof FencedError) fenced = err
    })
  }, intervalMs)
  try {
    const result = await work()
    if (fenced) throw fenced
    return result
  } finally {
    clearInterval(timer)
  }
}

type MessageRow = { role: 'user' | 'agent'; content: string }

async function loop(deps: WorkerDeps, claim: Claim): Promise<void> {
  const { sql, limits } = deps
  let state: TurnState = claim.state ?? { ...EMPTY }

  if (state.messages.length === 0) {
    const rows = await sql<MessageRow[]>`
      select role, content from messages
       where conversation_id = ${claim.conversationId} order by created_at`
    state = {
      ...state,
      messages: rows.map((r): LoopMessage => ({
        role: r.role === 'agent' ? 'assistant' : 'user',
        content: r.content,
      })),
    }
  }

  for (;;) {
    const spend = await readSpendFailClosed(sql, claim.userId, claim.conversationId)
    const decision = decideNext({
      state, spend, limits,
      nowMs: deps.now(), deadlineMs: deps.deadlineMs(), estStepMs: EST_STEP_MS,
      pendingUserMessage: null,
    })

    switch (decision.kind) {
      case 'stop':
        await failTurn(sql, claim, decision.reason)
        return
      case 'continue_later':
        // Persist state AND release ownership (status -> 'queued') in one statement,
        // THEN schedule — see releaseForContinuation's doc comment. Using
        // saveTurnState here would leave the turn 'running' with a fresh
        // heartbeat_at, so the re-invocation's own claimTurn could never claim it.
        await releaseForContinuation(sql, claim, state)
        await deps.reinvoke(claim.turnId)
        return
      case 'park':
        // decideNext never returns this today (Task 1 ruling — parking isn't wired
        // up yet). Handled explicitly, rather than silently falling through to
        // calling the agent, so a later plan that wires this up must replace this
        // throw with real behavior instead of finding it already "working" by
        // accident.
        throw new Error(`worker: 'park' decision is not implemented (message: ${decision.message})`)
      case 'call_model':
        break // fall through to invoking the agent below
      default: {
        // Exhaustiveness guard for any FUTURE Decision variant: the compiler
        // rejects this file the moment engine.ts grows a kind not listed above.
        const unhandled: never = decision
        throw new Error(`worker: unhandled decision kind ${JSON.stringify(unhandled)}`)
      }
    }

    const step = await withHeartbeat(
      sql, claim, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      () => deps.agent({ state, conversationId: claim.conversationId, userId: claim.userId }),
    )

    if (step.kind === 'message') {
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
      await completeTurn(sql, claim, {
        state, agentMessage: step.text, parked: true, spendMicros: 0n,
      })
      return
    }

    const outcome = await beginToolCall(sql, claim.turnId, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      // The previous attempt died mid-side-effect. We cannot know whether it ran
      // (e.g. an email already sent), so we escalate rather than guess either way.
      await failTurn(sql, claim, 'fenced')
      return
    } else {
      result = await step.run()
      await finishToolCall(sql, claim.turnId, step.callId, result)
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
    }

    state = {
      ...state,
      step: state.step + 1,
      messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
    }
    await saveTurnState(sql, claim, state)
  }
}
