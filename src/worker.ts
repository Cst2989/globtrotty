import type postgres from 'postgres'
import { decideNext, type Limits, type TurnState, type LoopMessage } from './engine.js'
import {
  claimTurn, saveTurnState, completeTurn, failTurn, FencedError, type Claim,
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
}

const EST_STEP_MS = 60_000
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

    if (decision.kind === 'stop') { await failTurn(sql, claim, decision.reason); return }

    if (decision.kind === 'continue_later') {
      await saveTurnState(sql, claim, state)     // persist FIRST
      await deps.reinvoke(claim.turnId)          // then schedule
      return
    }

    const step = await deps.agent({
      state, conversationId: claim.conversationId, userId: claim.userId,
    })

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
