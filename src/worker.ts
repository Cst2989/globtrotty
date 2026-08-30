import type postgres from 'postgres'
import { decideNext, type FailReason, type Limits, type LoopMessage, type TurnState } from './engine.js'
import { classifyError } from './errors.js'
import { limitReachedMessage } from './limit-message.js'
import { readSpendOrLimitReached } from './loop.js'
import { readSpendFailClosed, recordSpend } from './repo/spend.js'
import { beginToolCall, finishToolCall } from './repo/toolCalls.js'
import {
  claimTurn, completeTurn, failTurn, heartbeat, releaseForContinuation, saveTurnState,
  FencedError, MAX_ATTEMPTS, type Claim,
} from './repo/turns.js'
import { withRetry } from './retry.js'

export type AgentContext = {
  state: TurnState
  conversationId: string
  userId: string
  turnId: string
  /**
   * The fencing token this run's claim holds. Not part of the brief's original
   * shape; added so a driver that needs to write through the ledger
   * (`ledgerRunner`, src/tools.ts, which lesson 3.4's fix round took a `Claim`
   * rather than a bare turn id) can rebuild one without the harness handing out
   * its own `Claim` object, which would let an agent call `saveTurnState` or a
   * closer directly and step around the loop that owns those calls.
   */
  attempts: number
}

/**
 * One move. The harness knows these three and nothing about what produced them,
 * which is why the whole of module 3 can be proved without a model: a fake agent
 * and a real agent are the same shape.
 */
export type AgentStep =
  | { kind: 'message'; text: string; costMicros: bigint }
  | { kind: 'tool'; callId: string; name: string; run: () => Promise<unknown>; costMicros: bigint }
  | { kind: 'fail'; reason: FailReason; text: string | null; costMicros: bigint }

export type Agent = (ctx: AgentContext) => Promise<AgentStep>

export type WorkerDeps = {
  sql: postgres.Sql
  limits: Limits
  agent: Agent
  now: () => number
  deadlineMs: () => number
  reinvoke: (turnId: string) => Promise<void>
  /** How often to say "still here" while a step is in flight. */
  heartbeatIntervalMs?: number
  /** Called on every heartbeat tick, so a test can count them. */
  onHeartbeat?: () => void
  /** Injected into withRetry, so a test waits for nothing. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const EST_STEP_MS = 60_000
// Well under HEARTBEAT_STALE (90s), so a real step keeps refreshing heartbeat_at
// several times before the sweeper's window could close on it.
const HEARTBEAT_INTERVAL_MS = 25_000
// A factory, not a shared constant. A module-level `EMPTY` spread into
// `{ ...EMPTY }` copies the object and keeps the SAME messages array, so every
// fresh turn in the process would share one transcript. Nothing mutates it
// today, which is exactly what makes it the kind of trap this module is about.
const emptyState = (): TurnState => ({ step: 0, messages: [] })

/** Proves the harness without a model: says back what she said. */
export const echoAgent: Agent = async ({ state }) => {
  const last = [...state.messages].reverse().find((m) => m.role === 'user')
  return { kind: 'message', text: `You said: ${last?.content ?? '(nothing)'}`, costMicros: 1_000n }
}

/**
 * Claims a turn and runs it to one of its ends. Returns quietly when somebody
 * else owns it, which on a platform that retries invocations is the ordinary
 * case and not a failure.
 */
export async function runTurn(deps: WorkerDeps, turnId: string): Promise<void> {
  const { sql } = deps
  const claim = await claimTurn(sql, turnId)
  if (!claim) return

  // Accumulated across every step of this run, so whichever exit fires records
  // what the turn actually spent rather than always writing zero.
  const turnSpend = { total: 0n }

  try {
    await loop(deps, claim, turnSpend)
  } catch (err) {
    // FencedError returns FIRST and is never classified. A superseded worker
    // must write nothing at all, and stamping a reason on a turn it no longer
    // owns would overwrite the run that took it over.
    if (err instanceof FencedError) return
    // Everything else is classified rather than recorded as one word. There is
    // no retry mechanism for this to feed: failTurn is terminal and the sweeper
    // only ever looks at queued and running rows. It changes what the row SAYS,
    // which is what somebody reads at three in the morning. The assignment below
    // is also the compile-time proof that every ClassifiedReason (src/errors.ts)
    // is a real FailReason (src/engine.ts); errors.ts deliberately does not
    // import the engine, so this call site is where the two are pinned together.
    const { reason } = classifyError(err)
    await failTurn(sql, claim, reason, turnSpend.total).catch(() => {})
    throw err
  }
}

/**
 * Runs `work` while saying "still here" on a timer, so a step that outlives the
 * staleness window is not mistaken for a dead process mid call. A tick that
 * discovers we have been superseded captures the error and re-throws it once
 * `work` settles, so the loop stops acting on a turn it no longer owns. Any
 * other heartbeat failure is transient and swallowed, and the next tick retries:
 * a tick must never surface as an unhandled rejection.
 */
async function withHeartbeat<T>(deps: WorkerDeps, claim: Claim, work: () => Promise<T>): Promise<T> {
  // A holder object, not a bare `let`. The only assignment lives in a nested
  // callback TypeScript does not track, so a plain `let fenced: FencedError |
  // null = null` is still narrowed to `null` at the `if` below and the guard is
  // dead at type level. A property read cannot be narrowed that way.
  const seen: { fenced: FencedError | null } = { fenced: null }
  const timer = setInterval(() => {
    deps.onHeartbeat?.()
    heartbeat(deps.sql, claim).catch((err: unknown) => {
      if (err instanceof FencedError) seen.fenced = err
    })
  }, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  try {
    const result = await work()
    if (seen.fenced) throw seen.fenced
    return result
  } finally {
    clearInterval(timer)
  }
}

type MessageRow = { role: 'user' | 'agent'; content: string }

async function loop(deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint }): Promise<void> {
  const { sql, limits } = deps
  let state: TurnState = claim.state ?? emptyState()

  if (state.messages.length === 0) {
    // A fresh claim of a turn nobody has worked yet: the transcript is whatever
    // is already in her thread. By seq, never by created_at, for the reason
    // course.messages carries a seq at all.
    const rows = await sql<MessageRow[]>`
      select role, content from course.messages
       where conversation_id = ${claim.conversationId} order by seq`
    state = {
      ...state,
      messages: rows.map((r): LoopMessage => ({
        role: r.role === 'agent' ? 'assistant' : 'user',
        content: r.content,
      })),
    }
  }

  for (;;) {
    // The same fail-closed read the loop uses (lesson 2.6), through the same
    // helper: a read that cannot confirm what was spent denies exactly like a
    // ceiling that was reached, because both mean "cannot prove it is safe to
    // spend more", and an uncaught throw here would strand the turn.
    const read = await readSpendOrLimitReached(
      () => readSpendFailClosed(sql, claim.userId, claim.conversationId),
    )
    if (read === 'limit_reached') {
      await failTurn(sql, claim, 'limit_reached', turnSpend.total,
        limitReachedMessage('limit_reached', limits))
      return
    }

    const decision = decideNext({
      state, spend: read, limits,
      nowMs: deps.now(), deadlineMs: deps.deadlineMs(), estStepMs: EST_STEP_MS,
      pendingUserMessage: null,
    })

    switch (decision.kind) {
      case 'stop':
        await failTurn(sql, claim, decision.reason, turnSpend.total,
          decision.reason === 'limit_reached' ? limitReachedMessage(read, limits) : null)
        return
      case 'continue_later':
        if (claim.attempts >= MAX_ATTEMPTS - 1) {
          // Handed back, this turn would be one claimTurn can never take again:
          // requeued by every sweep, worked by nothing, her conversation held
          // shut until the sweeper reaps it. It ends here instead, with the
          // reason that says what happened.
          await failTurn(sql, claim, 'deadline_exceeded', turnSpend.total)
          return
        }
        // State AND ownership in one statement, then schedule. saveTurnState
        // alone would leave the row running with a fresh heartbeat, which the
        // re-invocation's own claimTurn can satisfy through neither arm.
        await releaseForContinuation(sql, claim, state)
        await deps.reinvoke(claim.turnId)
        return
      case 'park':
        // decideNext never returns this yet. Handled explicitly rather than
        // falling through to calling the agent, so whoever wires parking up has
        // to replace this throw instead of finding it already working by luck.
        throw new Error(`worker: 'park' is not implemented (message: ${decision.message})`)
      case 'call_model':
        break
      default: {
        const unhandled: never = decision
        throw new Error(`worker: unhandled decision ${JSON.stringify(unhandled)}`)
      }
    }

    // Retried here, around the whole step, and safe to retry precisely because
    // lesson 3.4 built the ledger: a step that already ran its tool replays that
    // tool's result instead of running it again.
    const step = await withHeartbeat(deps, claim, () =>
      withRetry(
        () => deps.agent({
          state, conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
          attempts: claim.attempts,
        }),
        { sleep: deps.sleep, random: deps.random },
      ))

    if (step.kind === 'fail') {
      await spend(deps, claim, turnSpend, step.costMicros)
      await failTurn(sql, claim, step.reason, turnSpend.total, step.text)
      return
    }

    if (step.kind === 'message') {
      // heartbeat as a cheap ownership assertion. recordSpend and completeTurn
      // take bare ids and carry no fencing token of their own, so this fenced
      // single-row update stands in for them: if we have been superseded it
      // throws here, before any money is spent.
      await heartbeat(sql, claim)
      await spend(deps, claim, turnSpend, step.costMicros)
      await completeTurn(sql, claim, {
        state, agentMessage: step.text, parked: true, spendMicros: turnSpend.total,
      })
      return
    }

    await heartbeat(sql, claim)
    const outcome = await beginToolCall(sql, claim, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      // Started and never finished: the effect on the outside world is unknown,
      // and guessing either way is worse than stopping.
      await failTurn(sql, claim, 'fenced', turnSpend.total)
      return
    } else {
      // Wrapped exactly like the agent call above: a real supplier request can
      // run past the staleness window, so heartbeat_at has to keep moving while
      // it is in flight and not only either side of it.
      result = await withHeartbeat(deps, claim, () => step.run())
      await heartbeat(sql, claim)
      await finishToolCall(sql, claim, step.callId, result)
      await spend(deps, claim, turnSpend, step.costMicros)
    }

    state = {
      ...state,
      step: state.step + 1,
      messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
    }
    await saveTurnState(sql, claim, state)
  }
}

/**
 * Adds one step's cost to the ledger and to this run's total. Skipped entirely
 * at zero, which is not an optimisation: tier 3's agent is metered per model
 * call by `ledgerSink` (lesson 2.6) and reports 0n here, and calling recordSpend
 * with nothing to record would touch two rows to add nothing.
 */
async function spend(
  deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint }, costMicros: bigint,
): Promise<void> {
  if (costMicros === 0n) return
  await recordSpend(deps.sql, {
    userId: claim.userId, conversationId: claim.conversationId, costMicros,
  })
  turnSpend.total += costMicros
}
