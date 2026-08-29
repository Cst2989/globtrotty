import type postgres from 'postgres'
import { decideNext, type Limits, type TurnState, type LoopMessage } from './engine.js'
import {
  claimTurn, saveTurnState, completeTurn, failTurn, heartbeat, releaseForContinuation,
  FencedError, type Claim,
} from './repo/turns.js'
import { classifyError } from './errors.js'
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

  // Accumulated across every step of this run, so whichever exit path fires —
  // completeTurn, failTurn on a decideNext stop, or the crash handler below —
  // records what this turn actually spent instead of always writing 0.
  const turnSpend = { total: 0n }

  try {
    await loop(deps, claim, turnSpend)
  } catch (err) {
    if (err instanceof FencedError) return // superseded: write nothing
    // FencedError above returns FIRST and is never classified: a superseded worker
    // must write nothing at all, and stamping a fail_reason on a turn it no longer
    // owns would overwrite the run that took it over.
    //
    // Everything else is classified rather than blanket-recorded as 'provider_down'
    // (plan 1's accepted limitation, now removed). `reason` is what distinguishes a
    // permanent fault from a transient one on the row itself; `retryable` is the
    // model client's business (plan 3: honour Retry-After, back off, give up), not
    // this handler's, because failTurn is terminal either way. That terminality IS
    // the guard the brief asks for: a 'failed' turn matches neither arm of the
    // sweeper's `status in ('queued','running')` predicate, so a non-retryable
    // failure can never be requeued until it is reaped as a crash loop, however
    // stale its heartbeat gets. Pinned by test/worker.test.ts.
    //
    // The assignment below is also the compile-time check that every
    // ClassifiedReason (src/errors.ts) is a real FailReason (src/engine.ts) --
    // errors.ts deliberately does not import the engine, so this is where the two
    // unions are proven to agree.
    const { reason } = classifyError(err)
    await failTurn(sql, claim, reason, turnSpend.total).catch(() => {})
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

async function loop(
  deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint },
): Promise<void> {
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
        await failTurn(sql, claim, decision.reason, turnSpend.total)
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
      // heartbeat() as a cheap ownership assertion: recordSpend and completeTurn
      // don't carry the `attempts` fencing token themselves (they take bare ids),
      // so this fenced single-row update stands in for them — if we've been
      // superseded it throws FencedError here, before any money is spent.
      await heartbeat(sql, claim)
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
      turnSpend.total += step.costMicros
      await completeTurn(sql, claim, {
        state, agentMessage: step.text, parked: true, spendMicros: turnSpend.total,
      })
      return
    }

    // Same ownership assertion ahead of beginToolCall — a superseded worker must
    // not be the one deciding whether this tool call is fresh.
    await heartbeat(sql, claim)
    const outcome = await beginToolCall(sql, claim.turnId, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      // The previous attempt died mid-side-effect. We cannot know whether it ran
      // (e.g. an email already sent), so we escalate rather than guess either way.
      await failTurn(sql, claim, 'fenced', turnSpend.total)
      return
    } else {
      // Wrapped exactly like deps.agent(...) above: a real supplier call (plan 3)
      // can run past HEARTBEAT_STALE, so heartbeat_at must keep advancing while
      // it's in flight, not just before and after.
      result = await withHeartbeat(
        sql, claim, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
        () => step.run(),
      )
      // ...and ahead of finishToolCall — a superseded worker must not be the one
      // recording this tool call's result as authoritative.
      await heartbeat(sql, claim)
      await finishToolCall(sql, claim.turnId, step.callId, result)
      await heartbeat(sql, claim)
      await recordSpend(sql, {
        userId: claim.userId, conversationId: claim.conversationId,
        costMicros: step.costMicros,
      })
      turnSpend.total += step.costMicros
    }

    state = {
      ...state,
      step: state.step + 1,
      messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
    }
    await saveTurnState(sql, claim, state)
  }
}
