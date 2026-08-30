import type postgres from 'postgres'
import { handOffMessage } from './cashier.js'
import { decideNext, type FailReason, type Limits, type TurnState } from './engine.js'
import { classifyError } from './errors.js'
import { TURN_FAILED_MESSAGE } from './failure-message.js'
import { limitReachedMessage } from './limit-message.js'
import { readSpendOrLimitReached } from './loop.js'
import { emittedLinks } from './repo/linkClicks.js'
import { readSpendFailClosed, recordSpend } from './repo/spend.js'
import { beginToolCall, finishToolCall } from './repo/toolCalls.js'
import {
  claimTurn, completeTurn, failTurn, heartbeat, loadTurnInput, releaseForContinuation, saveTurnState,
  FencedError, HEARTBEAT_INTERVAL, MAX_ATTEMPTS, type Claim, type TurnCloser,
} from './repo/turns.js'
import { withRetry, RetryBudgetExceededError } from './retry.js'

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
  /**
   * Aborted the instant a heartbeat tick discovers this worker has been
   * superseded (`withHeartbeat`, below). A driver that makes more than one
   * model or tool call inside a single step (tier 3's `turn()` is exactly
   * this: classify, extract, and every step of its own tool loop) has no
   * other way to learn mid-flight that the row underneath it now belongs to
   * someone else, and without this a fenced worker keeps calling the model
   * and keeps billing `conversations.spend_usd_micros` for up to the rest of
   * its budget after another worker has already taken over the same turn.
   * Checking it is opt-in: a driver wraps whatever it hands to the model
   * client and to its own tool runner so each call refuses to record once
   * aborted, the same way `beginToolCall` already refuses to write once the
   * claim's attempts no longer match. A driver that never checks it is no
   * worse off than before this field existed; `withHeartbeat` still re-throws
   * the fence once the step itself settles, as it always has.
   */
  signal: AbortSignal
}

/**
 * What one step cost, and whether the harness still has to bill it.
 *
 * `costMicros` means the same thing on every kind of step: what THIS step
 * spent. `runTurn` accumulates it and whichever exit fires writes the total to
 * `turns.spend_usd_micros`, so that column answers "what did this turn cost"
 * whatever kind of agent ran it.
 *
 * `alreadyRecorded` answers a separate question: has this money reached
 * `course.conversations` and `course.daily_usage` yet? A fake agent
 * (`echoAgent`, and the tests) meters itself and writes nowhere, so the
 * harness records it through `recordSpend`. Tier 3's driver bills every model
 * call to both ledgers through `ledgerSink` (lesson 2.6) as it makes it, so it
 * reports what it spent and sets this flag, and the harness counts the money
 * for the turn without charging the conversation for it twice. That driver
 * reported `0n` instead until lesson 3.7's whole-branch review: the two
 * ledgers stayed right and `turns.spend_usd_micros` read as free for every
 * turn tier 3 had ever run.
 */
type StepCost = { costMicros: bigint; alreadyRecorded?: boolean }

/**
 * One move. The harness knows these four and nothing about what produced them,
 * which is why the whole of module 3 can be proved without a model: a fake
 * agent and a real agent are the same shape.
 */
export type AgentStep =
  | ({ kind: 'message'; text: string } & StepCost)
  | ({ kind: 'tool'; callId: string; name: string; run: (signal: AbortSignal) => Promise<unknown> } & StepCost)
  | ({ kind: 'fail'; reason: FailReason; text: string | null } & StepCost)
  /**
   * The driver's OWN budget ran out mid-step, not the harness's. Tier 3's
   * `turn()` carries its own deadline-aware loop (src/loop.ts) independent of
   * `decideNext`'s check at the top of this file's own loop, and a step that
   * starts with plenty of room can still cross that inner deadline before it
   * returns. Neither a fail reason (nothing went wrong) nor a message (there
   * is nothing to say yet), so the turn is handed back and re-invoked exactly
   * the way `decideNext`'s own `continue_later` is, not recorded as `done`
   * with an empty reply.
   *
   * This is a RESTART, not a resume, for as long as one agent step is the
   * whole of `turn()`: the harness's own `state.messages` holds only the one
   * seeded user line, carries none of the driver's internal notebook or
   * conversation, and the re-invoked driver calls `turn()` again from
   * scratch. `classify`, `extract` and every tool step it already paid for
   * are paid for again, up to `MAX_ATTEMPTS` times for one press, bounded
   * only by the conversation ceiling. Strictly better than recording the
   * turn `done` with a blank reply, which is what a review caught this
   * lesson doing before this type existed; module 5, which moves the
   * driver's own steps inside the harness, is where a continuation resumes
   * instead of restarting.
   *
   * It carries a cost like every other step, because a restart is not free:
   * whatever the driver spent before its own budget ran out has to reach
   * `turns.spend_usd_micros` through the hand-back
   * (`releaseForContinuation`), or a turn that continued three times would
   * report only what its last attempt spent.
   */
  | ({ kind: 'continue_later' } & StepCost)

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
  // The last state the loop reached, so the catch below can complete a turn
  // that already emitted a booking link rather than failing it. A box for the
  // same reason turnSpend is one: `loop` owns it and `runTurn`'s catch has to
  // be able to read it after `loop` has thrown.
  const progress = { state: emptyState() }

  try {
    await loop(deps, claim, turnSpend, progress)
  } catch (err) {
    // FencedError returns FIRST and is never classified. A superseded worker
    // must write nothing at all, and stamping a reason on a turn it no longer
    // owns would overwrite the run that took it over.
    if (err instanceof FencedError) return
    // The point of no return (src/cashier.ts, rule 6), through
    // `completeIfLinkEmitted`, which is the same helper the five failing exits
    // reach through `failTurnUnlessLinkEmitted`, so there is one copy of the
    // read and one description of what it does. It is called directly here
    // because there is no `failTurn` wanted on this path: the error below is
    // re-thrown either way. If this turn already emitted a booking link,
    // she may be on a supplier's checkout page right now, and marking the turn
    // failed would tell her a request that DID something did nothing. The
    // original error still propagates either way: this changes what the turn
    // SAYS, not whether the failure is reported.
    if (await completeIfLinkEmitted(deps, claim, progress.state, turnSpend.total)) throw err
    // Everything else is classified rather than recorded as one word. There is
    // no retry mechanism for this to feed: failTurn is terminal and the sweeper
    // only ever looks at queued and running rows. It changes what the row SAYS,
    // which is what somebody reads at three in the morning. The assignment below
    // is also the compile-time proof that every ClassifiedReason (src/errors.ts)
    // is a real FailReason (src/engine.ts); errors.ts deliberately does not
    // import the engine, so this call site is where the two are pinned together.
    const { reason } = classifyError(err)
    // The sentence matters as much as the reason. `fail_reason` is for whoever
    // is on call; this is for her, and without it a crashed turn and a hung turn
    // look identical from her side of the screen. It is the same sentence the
    // sweeper writes when it reaps a crash loop (src/failure-message.ts), so a
    // failure reads the same whether the worker noticed it or the floor walk did.
    //
    // This closes the throw path and ONLY the throw path, so the rest of the
    // file is worth reading with that in mind. Ending with something for her to
    // read: this catch, the two `limit_reached` exits (which write
    // `limitReachedMessage` instead, because a ceiling is her news rather than
    // ours), an agent's own `fail` step when it supplies text, and a completed
    // turn whose agent had an answer to give. Ending with nothing in her
    // thread: `continueLater`'s `deadline_exceeded`, the `stop` branch for any
    // reason other than `limit_reached`, `ambiguous_tool_call`, and a completed
    // turn whose text was blank, since `completeTurn` writes no row for a null
    // message (src/repo/turns.ts) and an empty bubble reads worse than none.
    // The first three set `conversations.status = 'failed'` and so at least
    // stop her spinner; the fourth parks the conversation on `awaiting_user`
    // with nothing new above it, which is the quietest of the four. None of the
    // four is an oversight this lesson is fixing, and none is covered by the
    // guarantee above either; closing them is a later lesson's, and until then
    // this comment is the honest list rather than a claim that every turn
    // ending without an answer says something.
    //
    // The whole list describes a turn that emitted no booking link. Once one
    // has gone out, every exit in it ends the turn `done` with the hand-off
    // sentence instead, through one of two helpers below. This catch calls
    // `completeIfLinkEmitted` directly, because it has an error to re-throw
    // afterwards and never wanted `failTurn` at all. The five exits that DO
    // want it, `continueLater`'s cap arm and `loop`'s four, call
    // `failTurnUnlessLinkEmitted`, which is `completeIfLinkEmitted` plus the
    // `failTurn` to fall back to when nothing went out. Two helpers, one read
    // of `course.link_clicks`, one description of what it does.
    //
    // Logged, not discarded: a fail-closed throw from completeTurn/failTurn
    // itself ("conversation not found") or any other database error here is
    // exactly the evidence that a turn left `running` by a failed write needs.
    // Swallowing it silently would make that turn indistinguishable from an
    // ordinary crashed worker until the sweeper's staleness window closes.
    await failTurn(sql, claim, reason, turnSpend.total, TURN_FAILED_MESSAGE).catch((e: unknown) => {
      console.error(`failTurn for turn ${claim.turnId} failed`, e)
    })
    throw err
  }
}

/**
 * The point of no return (src/cashier.ts, rule 6) as one function, and the only
 * place in this codebase that reads `course.link_clicks` in order to decide how
 * a turn ends.
 *
 * Returns true when this turn had already emitted a booking link, in which case
 * it is now `done`, carrying the same sentence the hand-off said, and the
 * caller must not mark it failed. Returns false when nothing went out and the
 * caller is free to do whatever it was going to do.
 *
 * Exported for one caller outside this file, `sweep` (src/sweeper.ts), which
 * reaches the same state by a different road: a worker that died outright, so
 * that not even `runTurn`'s catch ran. Until lesson 4.6's whole-branch fix the
 * sweeper carried its own SQL version of this decision and reached a different
 * answer, marking such a turn `failed` with `crash_loop` and merely staying
 * quiet about it, so rule 6 was a worker rule the floor walk contradicted. It
 * is one rule with one implementation now. The sweeper holds no claim, so it
 * passes `completeReapedTurn` (src/repo/turns.ts) as `close`; every other
 * caller takes the default.
 *
 * `deps` is narrowed to the two things this actually uses, so the sweeper does
 * not have to invent an `Agent`, a deadline and a reinvoker to close one turn.
 * A `WorkerDeps` satisfies it as it stands.
 *
 * Nothing is re-quoted and nothing is recomputed: the rows carry the exact URLs
 * she was given, whether they were verified, and when they were quoted, so the
 * age comes off `quoted_at` and never off the clock. An unverified message
 * rebuilt against `now` would tell her a price quoted four hours ago was
 * current just now, which is the untrue reassurance this whole lesson refuses.
 * `?? now` is unreachable under the length check and exists only because the
 * type admits a null for the no-rows case.
 *
 * Best effort throughout, and deliberately so: after emission she may be on a
 * supplier's checkout page, and everything here is about describing that world
 * rather than changing it. A read that fails is logged and treated as "nothing
 * emitted", because a database this cannot read is a database the caller's own
 * `failTurn` cannot write to either. A write that fails is logged too, and that
 * includes `handOffMessage` itself throwing: a turn that handed off twice in
 * two currencies cannot be totalled (`sumMoney`, src/money.ts), and building
 * the message inside the argument list let that throw escape and REPLACE the
 * error the turn actually died of. Nothing here throws, so a caller that is
 * already handling one failure is never handed a second.
 */
export async function completeIfLinkEmitted(
  deps: { sql: postgres.Sql; now: () => number },
  claim: Claim, state: TurnState, spendMicros: bigint,
  close: TurnCloser = completeTurn,
): Promise<boolean> {
  const { sql } = deps
  const emitted = await emittedLinks(sql, claim.turnId).catch((e: unknown) => {
    console.error(`emittedLinks for turn ${claim.turnId} failed`, e)
    return { links: [], verified: false, quotedAt: null }
  })
  if (emitted.links.length === 0) return false
  const now = new Date(deps.now())
  try {
    await close(sql, claim, {
      state,
      agentMessage: handOffMessage(emitted.links, emitted.verified, emitted.quotedAt ?? now, now),
      parked: true,
      spendMicros,
    })
  } catch (e) {
    console.error(`closing turn ${claim.turnId} after link emission failed`, e)
  }
  return true
}

/**
 * The one way `loop` marks a turn failed.
 *
 * Four of its exits reach `failTurn` without ever throwing, so none of them
 * passes through `runTurn`'s catch: the fail-closed spend read at the top of
 * the next iteration, `decideNext` saying stop, an ambiguous tool call, and the
 * agent's own `fail` step. The last is reachable in the product today
 * (netlify/functions/run-turn-background.mts maps any classified failure out of
 * `turn()` into a `fail` step), and it is the one that matters: the model calls
 * `hand_off_to_booking`, the cashier writes `course.link_clicks` and returns
 * two live booking URLs, the next model call inside `turn()` loses the
 * provider, and the turn she is in the middle of paying for is marked failed
 * with nothing to read. Routing all four through here rather than repeating the
 * check at each means a fifth exit added tomorrow is guarded by construction.
 *
 * `continueLater`'s cap arm goes through it too, for the same reason: at
 * `MAX_ATTEMPTS` there is no attempt left to hand back with, so it ends the
 * turn rather than requeueing it, and ending it is the thing rule 6 forbids.
 * Its other arm, the hand-back itself, does NOT read this table, and neither
 * does the sweeper's requeue arm; README.md carries that as a named residual.
 */
async function failTurnUnlessLinkEmitted(
  deps: WorkerDeps, claim: Claim, state: TurnState, spendMicros: bigint,
  reason: FailReason, agentMessage: string | null = null,
): Promise<void> {
  if (await completeIfLinkEmitted(deps, claim, state, spendMicros)) return
  await failTurn(deps.sql, claim, reason, spendMicros, agentMessage)
}

/**
 * Runs `work` while saying "still here" on a timer, so a step that outlives the
 * staleness window is not mistaken for a dead process mid call. `work` is
 * handed an `AbortSignal` an opt-in caller can check between its own model or
 * tool calls (`AgentContext.signal`, above); a tick that discovers we have
 * been superseded aborts it at once, carrying the `FencedError` itself as the
 * signal's `reason`, so a caller that checks it can re-throw the very error
 * that will short-circuit `runTurn`'s catch rather than inventing its own.
 *
 * `work` is not guaranteed to notice. Aborting the signal cancels a call that
 * was HANDED the signal, which from lesson 4.2 is tier 3's model call and its
 * supplier fetch both; a caller that never threads it anywhere (a fake agent
 * in a test, a driver that only checks the flag between calls) simply keeps
 * running, and the check after `work()` settles is the backstop that still
 * catches that case, exactly as it always has. That backstop carries more
 * weight from lesson 4.2 than it used to: an aborted model call surfaces as
 * `APIUserAbortError`, which classifies as `unclassified` (src/errors.ts) and
 * comes back from the driver as an ordinary `fail` step, so this post-check is
 * what stops a fenced worker from even trying to stamp `unclassified` on a
 * turn it no longer owns; without it, `failTurn`'s own fenced predicate would
 * still refuse the write and throw `FencedError`, so the check saves a wasted
 * write rather than standing alone. Any OTHER heartbeat
 * failure is transient and swallowed, and the next tick retries: a tick must
 * never surface as an unhandled rejection.
 */
async function withHeartbeat<T>(
  deps: WorkerDeps, claim: Claim, work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setInterval(() => {
    deps.onHeartbeat?.()
    heartbeat(deps.sql, claim).catch((err: unknown) => {
      if (err instanceof FencedError) controller.abort(err)
    })
  }, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL * 1_000)
  try {
    const result = await work(controller.signal)
    if (controller.signal.aborted) throw controller.signal.reason
    return result
  } finally {
    clearInterval(timer)
  }
}

/**
 * Hands the lease back and schedules a fresh invocation, for the three ways a
 * step can end unfinished rather than done: `decideNext` saying so before the
 * agent is even called, the agent's own `continue_later` step when a driver's
 * inner budget ran out mid-step, and a retry `withRetry` refused because the
 * wait would cross what is left of this invocation (`RetryBudgetExceededError`,
 * src/retry.ts, added in lesson 3.6's second fix round). All three mean the
 * same thing to this row: the work is unfinished and still worth doing, by a
 * later invocation rather than by this one. Ends the turn instead when there is
 * no attempt left to hand it back with: `claimTurn` refuses a turn at
 * `MAX_ATTEMPTS`, so a released turn at the cap is claimable by nothing and
 * would sit forever, held shut, for the sweeper's crash-loop arm to eventually
 * reap as `crash_loop` anyway; ending it here as `deadline_exceeded` says the
 * true reason instead of waiting for that arm to relabel it.
 */
async function continueLater(
  deps: WorkerDeps, claim: Claim, state: TurnState, turnSpend: { total: bigint },
): Promise<void> {
  const { sql } = deps
  if (claim.attempts >= MAX_ATTEMPTS) {
    await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, 'deadline_exceeded')
    return
  }
  // State, ownership AND this attempt's spend in one statement, then schedule.
  // saveTurnState alone would leave the row running with a fresh heartbeat,
  // which the re-invocation's own claimTurn can satisfy through neither arm,
  // and it would drop the money as well: only the attempt that finally reaches
  // a closer would land on `turns.spend_usd_micros`, so a turn that continued
  // three times would report a third of its bill.
  await releaseForContinuation(sql, claim, state, turnSpend.total)
  // The row is already durable at 'queued': a failed re-invocation is not her
  // problem, exactly the way tier 2's own invokeAndLog treats a failed
  // deps.invoke (src/handler.ts). Logged and swallowed rather than left to
  // propagate, so a wrong SITE_URL or a cold-start 500 on the re-invocation
  // does not turn an already-successful hand-back into a thrown error tier 3
  // has no catch for.
  await deps.reinvoke(claim.turnId).catch((err: unknown) => {
    console.error(`reinvoke failed for turn ${claim.turnId}`, err)
  })
}

async function loop(
  deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint }, progress: { state: TurnState },
): Promise<void> {
  const { sql, limits } = deps
  let state: TurnState = claim.state ?? emptyState()
  // Reported after every assignment to `state`, so `runTurn`'s catch can
  // complete a turn that emitted a link with the transcript it actually
  // reached. The DECLARATION counts as one of the three: a RESUMED turn
  // already carries `claim.state` and skips the seeding block below entirely,
  // so without this line a resumed turn that emitted a link and then died
  // would be completed with an empty state.
  progress.state = state

  if (state.messages.length === 0) {
    // A fresh claim of a turn nobody has worked yet: seed the transcript from
    // exactly the message THIS turn was opened for, through the same
    // turn-scoped join `loadTurnInput` has carried since lesson 2.2. Never
    // "the newest message on the conversation": she can type again while this
    // turn is still queued (src/handler.ts's `busy` path stamps that message
    // `turn_id = null` on the SAME conversation), and reading the whole
    // conversation back would let a resumed turn answer a question this turn
    // was never opened for. `input` is null only for a turn nothing wrote a
    // message for at all, the sweeper's own `stalled` case; the transcript
    // then stays empty and the agent sees nothing to answer.
    const input = await loadTurnInput(sql, claim.turnId)
    state = {
      ...state,
      messages: input ? [{ role: 'user', content: input.message }] : [],
    }
    progress.state = state
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
      await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, 'limit_reached',
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
        await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, decision.reason,
          decision.reason === 'limit_reached' ? limitReachedMessage(read, limits) : null)
        return
      case 'continue_later':
        await continueLater(deps, claim, state, turnSpend)
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

    // Retried here, around the whole step, and safe to retry for the TOOL
    // effects a step makes: lesson 3.4's ledger replays a tool call it already
    // ran instead of running it again. It is NOT safe for model spend in the
    // same way. `classify` and `extract` (src/classify.ts, src/extract.ts)
    // call `callAndRecord` with no retry of their own, so a retryable
    // `APIError` from either escapes `turn()` and this whole step is retried
    // from scratch: a retried attempt pays for `classify` again even though
    // `ledgerSink` already billed the first attempt's call. `withRetry`
    // wrapping the whole step is the wrap this lesson has, over a single
    // agent-defined unit of work; wrapping only the model call the 429 or 5xx
    // actually came from is the narrower fix, and is not this lesson's.
    let step: AgentStep
    try {
      step = await withHeartbeat(deps, claim, (signal) =>
        withRetry(
          () => deps.agent({
            state, conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
            attempts: claim.attempts, signal,
          }),
          { sleep: deps.sleep, random: deps.random, remainingMs: () => deps.deadlineMs() - deps.now() },
        ))
    } catch (err) {
      // A wait `withRetry` refused to sleep because it would cross what is
      // left of THIS invocation's budget (src/retry.ts). The work is still
      // retryable and the provider is not the problem, so this is not
      // `provider_down`: it is the same fact as `decideNext`'s own
      // `continue_later`, arriving from inside the step instead of before
      // it, and it takes the identical hand-back rather than being
      // classified and failing a turn that only needs a later attempt.
      if (err instanceof RetryBudgetExceededError) {
        // The hand-back is right and the reason for it is not recorded anywhere
        // else: `deadline_exceeded` on the row says the invocation ran out of
        // time, not that a provider asked us to wait longer than we had. One
        // line, so that a recurring 429 reads as a 429 at three in the morning.
        console.error(`turn ${claim.turnId}: retry budget exceeded, handing back`, err.original)
        await continueLater(deps, claim, state, turnSpend)
        return
      }
      throw err
    }

    if (step.kind === 'continue_later') {
      await spend(deps, claim, turnSpend, step)
      await continueLater(deps, claim, state, turnSpend)
      return
    }

    if (step.kind === 'fail') {
      await spend(deps, claim, turnSpend, step)
      await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, step.reason, step.text)
      return
    }

    if (step.kind === 'message') {
      // heartbeat as a cheap ownership assertion. recordSpend and completeTurn
      // take bare ids and carry no fencing token of their own, so this fenced
      // single-row update stands in for them: if we have been superseded it
      // throws here, before any money is spent.
      await heartbeat(sql, claim)
      await spend(deps, claim, turnSpend, step)
      await completeTurn(sql, claim, {
        // Null, not an empty string, on a blank answer: completeTurn writes a
        // row for anything that is not null, and an empty bubble in her
        // thread reads worse than nothing.
        state, agentMessage: step.text || null, parked: true, spendMicros: turnSpend.total,
      })
      return
    }

    await heartbeat(sql, claim)
    const outcome = await beginToolCall(sql, claim, step.callId, step.name)
    let result: unknown
    if (outcome.status === 'replayed') {
      result = outcome.result
    } else if (outcome.status === 'ambiguous') {
      // Started and never finished: the effect on the outside world is
      // unknown, and guessing either way is worse than stopping. Its own
      // reason, not 'fenced': fenced means another worker holds the claim and
      // is alive to finish the turn, which needs nobody's attention.
      // 'ambiguous_tool_call' is the one outcome in this module that genuinely
      // needs a person (src/repo/toolCalls.ts, src/sweeper.ts's runbook).
      await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, 'ambiguous_tool_call')
      return
    } else {
      // Wrapped exactly like the agent call above: a real supplier request can
      // run past the staleness window, so heartbeat_at has to keep moving while
      // it is in flight and not only either side of it.
      result = await withHeartbeat(deps, claim, (signal) => step.run(signal))
      await heartbeat(sql, claim)
      await finishToolCall(sql, claim, step.callId, result)
      await spend(deps, claim, turnSpend, step)
    }

    state = {
      ...state,
      step: state.step + 1,
      messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
    }
    progress.state = state
    await saveTurnState(sql, claim, state)
  }
}

/**
 * Adds one step's cost to this run's total, and to the conversation and daily
 * ledgers unless the agent has already put it there itself (`StepCost`, above).
 * The total is what a closer or a hand-back writes to `turns.spend_usd_micros`,
 * so it is accumulated either way: a self-metering agent still has to say what
 * it spent, or the turn's own row reads as free. Skipped entirely at zero,
 * which is not an optimisation: a step that cost nothing would otherwise touch
 * two rows to add nothing.
 */
async function spend(
  deps: WorkerDeps, claim: Claim, turnSpend: { total: bigint }, step: StepCost,
): Promise<void> {
  if (step.costMicros === 0n) return
  if (!step.alreadyRecorded) {
    await recordSpend(deps.sql, {
      userId: claim.userId, conversationId: claim.conversationId, costMicros: step.costMicros,
    })
  }
  turnSpend.total += step.costMicros
}
