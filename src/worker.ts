import type postgres from 'postgres'
import { handOffMessage } from './cashier.js'
import { redactCurrency } from './channel.js'
import {
  decideNext, textOfBlocks,
  type ContentBlock, type FailReason, type Limits, type ToolResultBlock, type TurnState,
} from './engine.js'
import { classifyError } from './errors.js'
import { labelTurn } from './evals/trajectory.js'
import { TURN_FAILED_MESSAGE } from './failure-message.js'
import { limitReachedMessage } from './limit-message.js'
import { readSpendOrLimitReached } from './loop.js'
import { hasEscalated, recordAgentEvent } from './repo/agentEvents.js'
import { emittedLinks } from './repo/linkClicks.js'
import { readSpendFailClosed, recordSpend } from './repo/spend.js'
import { AmbiguousToolCallError } from './repo/toolCalls.js'
import { isToolOutcome } from './tools.js'
import {
  claimTurn, completeTurn, failTurn, heartbeat, loadTurnInput, releaseForContinuation, saveTurnState,
  FencedError, HEARTBEAT_INTERVAL, MAX_ATTEMPTS, type Claim, type TurnCloser,
} from './repo/turns.js'
import { withRetry, RetryBudgetExceededError } from './retry.js'
import { sanitizeOutbound } from './sanitize.js'

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
 * call to both ledgers itself, through `reserve` before dispatch and
 * `reconcile` after it answers (lesson 5.1), so it reports what it spent and
 * sets this flag, and the harness counts the money
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
  | ({
      /**
       * `callId` is the id the `tool_result` block this harness appends
       * references, which must be the id the `tool_use` block beside it carries
       * or the next request is a 400: for the driver that is the PROVIDER's own
       * id, straight off the reply. It is not a ledger key and nothing here
       * writes `course.tool_calls` with it. The ledger's key is the runner
       * chain's business, positional and stable across a re-ask
       * (src/agents/driver.ts, src/loop.ts), and the agent has already bound it
       * into `run` by the time a step reaches this file.
       *
       * `name` is what an operator reads when a call comes back ambiguous; the
       * transcript does not carry it.
       */
      kind: 'tool'; callId: string; name: string
      run: (signal: AbortSignal) => Promise<unknown>
      /**
       * The assistant turn that ASKED for this tool, appended to the transcript
       * before the result is. An Anthropic `tool_result` block references the
       * `tool_use` block's id in the preceding assistant message, so a harness
       * that appended only the result would send an unpaired `tool_result` on
       * the next step: a 400, on every tool call the system ever made, rather
       * than a degraded answer. `echoAgent` and the counting agents in the tests
       * pass an empty array, which is honest: they asked for nothing.
       */
      assistantContent: ContentBlock[]
    } & StepCost)
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
   * This was a RESTART, not a resume, while one agent step was the whole of
   * `turn()`: `state.messages` held only the one seeded user line, so the
   * re-invoked driver called `turn()` again from scratch and paid for
   * `classify`, `extract` and every tool step a second time, up to
   * `MAX_ATTEMPTS` times for one press, bounded only by the conversation
   * ceiling. Strictly better than recording the
   * turn `done` with a blank reply, which is what a review caught this
   * lesson doing before this type existed. Lesson 5.1 moved the driver's
   * steps inside the harness, so a hand-back now RESUMES from
   * `course.turns.state` and no production agent returns this kind any more.
   * It stays for an agent with its own inner loop, where a continuation is
   * still a restart.
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
  const said = last ? textOfBlocks(last.content) : ''
  return { kind: 'message', text: `You said: ${said || '(nothing)'}`, costMicros: 1_000n }
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
    // `emitted`, not `closed`: a close that threw leaves the row alive-looking
    // for the sweeper, and failing it here instead would be the very write rule
    // 6 forbids. Only the sweeper's operator-facing count reads `closed`.
    if ((await completeIfLinkEmitted(deps, claim, progress.state, turnSpend.total)).emitted) throw err
    // Everything else is classified rather than recorded as one word. There is
    // no retry mechanism for this to feed: failTurn is terminal and the sweeper
    // only ever looks at queued and running rows. It changes what the row SAYS,
    // which is what somebody reads at three in the morning. The assignment below
    // is also the compile-time proof that every ClassifiedReason (src/errors.ts)
    // is a real FailReason (src/engine.ts); errors.ts deliberately does not
    // import the engine, so this call site is where the two are pinned together.
    const { reason } = classifyError(err)
    // The feed she watches, from lesson 5.7. This is the catch-all end of the
    // throw path, so it is the one that files the row when nothing else could:
    // `loop`'s five failing exits write their own after `failTurn` returns, and
    // an exception that got past them, including a `failTurn` of theirs that
    // threw, arrives here with nothing written yet. Written before the
    // `failTurn` below rather than after it, because that one is best effort and
    // logged either way, so a feed that waited for it would go quiet exactly
    // when something is wrong. One turn, one `failed` row, on either road.
    await recordAgentEvent(sql, {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
      kind: 'failed', detail: reason,
    })
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

/** What `completeIfLinkEmitted` tells its caller. Two answers, see below. */
export type PointOfNoReturn = {
  /** A booking link had gone out, so no caller may mark this turn failed. */
  emitted: boolean
  /** The turn is now `done` with the hand-off sentence. Never true without `emitted`. */
  closed: boolean
}

/**
 * The point of no return (src/cashier.ts, rule 6) as one function, and the only
 * place in this codebase that reads `course.link_clicks` in order to decide how
 * a turn ends.
 *
 * Two answers, not one, because two callers ask two different questions.
 * `emitted` says a booking link had already gone out, so the caller must not
 * mark this turn failed whatever else happened; that is what `runTurn`'s catch
 * and `failTurnUnlessLinkEmitted` branch on, and it stays true even when the
 * close below threw, because a close that failed does not un-emit a link.
 * `closed` says the turn is now `done` carrying the hand-off sentence, which is
 * the narrower claim and the only one an operator-facing count may be built
 * from; `sweep` (src/sweeper.ts) reads it for `handedOff`. Both are false when
 * nothing went out and the caller is free to do whatever it was going to do.
 *
 * Reporting the wide answer as the narrow one was this fix round's own finding:
 * the two-currency turn below was pushed into `handedOff` and logged as
 * completed, for ever, which is a system describing a world it is not in.
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
): Promise<PointOfNoReturn> {
  const { sql } = deps
  const emitted = await emittedLinks(sql, claim.turnId).catch((e: unknown) => {
    console.error(`emittedLinks for turn ${claim.turnId} failed`, e)
    return { links: [], verified: false, quotedAt: null }
  })
  if (emitted.links.length === 0) return { emitted: false, closed: false }
  const now = new Date(deps.now())
  try {
    // The second writer of an agent message, through the same check as the
    // first (src/sanitize.ts, lesson 5.5). This sentence is built server side
    // from `course.link_clicks` rows and the model never touched it, so the
    // check has nothing to find. It runs anyway, because "every agent message
    // goes through it" is a claim about the WRITERS and a claim with an
    // exception is a claim the next writer inherits. It also proves the URL
    // rule admits the links the cashier actually built, which is the one thing
    // that rule must never get wrong: a stripped booking link here is a turn
    // that took her money's worth of work and handed her `[link removed]`.
    // Still inside the try, for the reason the docstring gives about
    // `handOffMessage` throwing.
    const handOff = sanitizeOutbound(
      handOffMessage(emitted.links, emitted.verified, emitted.quotedAt ?? now, now))
    if (!handOff.ok) {
      console.error(`turn ${claim.turnId}: hand-off message rewritten`, handOff.reasons)
    }
    await close(sql, claim, {
      state,
      agentMessage: handOff.text,
      parked: true,
      spendMicros,
    })
  } catch (e) {
    console.error(`closing turn ${claim.turnId} after link emission failed`, e)
    return { emitted: true, closed: false }
  }
  return { emitted: true, closed: true }
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
  // `emitted` for the same reason the catch above reads it: the fallback below
  // is the write rule 6 forbids on a turn that emitted, close or no close.
  const { emitted, closed } = await completeIfLinkEmitted(deps, claim, state, spendMicros)
  if (!emitted) {
    await failTurn(deps.sql, claim, reason, spendMicros, agentMessage)
    // AFTER the write it describes, and that ordering is the whole of what keeps
    // one turn to one `failed` row. `failTurn` can throw: a fenced one means
    // another worker owns the turn and this one must write nothing at all, and any
    // other throw propagates out of `loop` into `runTurn`'s catch, which files the
    // row itself. Writing here first would have produced two rows for one ending
    // in the second case and a row from a superseded worker in the first.
    // Routing all five of `loop`'s failing exits through this one function is what
    // makes that a single place rather than five.
    await recordAgentEvent(deps.sql, {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
      kind: 'failed', detail: reason,
    })
  }
  // One of the two terminal exits that label the turn (lesson 6.5). The early
  // return this replaced would have skipped it, and a turn that ended on a live
  // booking link is exactly the turn anybody later asks the counters about, so
  // both endings this function can reach write the row and the five failing
  // exits of `loop` inherit it from here. Last, because the label counts the
  // reply and whichever branch above is what wrote it.
  //
  // `emitted && !closed` is the one case that writes nothing, and it covers
  // EVERY close that did not land rather than a fence alone.
  // `completeIfLinkEmitted` never throws, and its try wraps `handOffMessage` and
  // `sanitizeOutbound` as well as the close itself, so whatever any of the three
  // raises is caught, logged, and reported as `{ emitted: true, closed: false }`.
  //
  // A fence is one of those causes and the one this guard was written for: a
  // `completeTurn` refused because another worker now owns the turn arrives
  // here, and without the guard the loser would insert the label row for a turn
  // it lost, the winner would then lose `turn_labels_pkey`, and the winner's log
  // would read "turn labels not written" for a row that exists, which is a
  // sentence `evals/run.ts` reads as a turn missing from `turns labelled`.
  //
  // The other causes are not fences, and what they cost is worth naming rather
  // than leaving inside the word "fence". A `handOffMessage` that cannot total
  // two currencies is this worker's own failure on a turn it still owns, and
  // skipping is still right, because counters over an ending nobody finished
  // would be a label row for a turn with no settled shape. But nothing logs the
  // skip. That turn joins the permanently unlabelled gap README.md owns under
  // lesson 6.5, without even the "turn labels not written" line to find it by.
  if (emitted && !closed) return
  await labelTurn(deps.sql, {
    turnId: claim.turnId, conversationId: claim.conversationId, userId: claim.userId,
  })
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
  // Written after the hand-back rather than before it, and this is the one feed
  // write on this path that is ordered deliberately: `releaseForContinuation` is
  // fenced, so a superseded worker throws there and never claims on the feed to
  // have parked a turn another worker now owns.
  await recordAgentEvent(sql, {
    conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
    kind: 'parked', detail: 'handed back for a later invocation',
  })
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
      messages: input ? [{ role: 'user', content: [{ type: 'text', text: input.message }] }] : [],
    }
    progress.state = state
  } else {
    // A claim that arrived carrying a transcript: this turn ran before, was
    // handed back or reaped, and is being picked up where it stopped. It is the
    // other half of the `parked` row above, and the two together are what makes
    // a turn that took three invocations readable as one story on the feed.
    await recordAgentEvent(sql, {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
      kind: 'continued', detail: `attempt ${claim.attempts}`,
    })
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
    // effects a step makes: the ledger inside the runner chain replays a call it
    // already ran instead of running it again, keyed on a call id that is stable
    // across the re-ask a retry produces (src/agents/driver.ts, src/loop.ts).
    // Nothing in a retried step reaches a supplier twice.
    //
    // The model calls are the part a retry repeats, and a step no longer makes
    // just one. Lesson 5.3 put a routing call in front of step 0
    // (`selectDesk`, src/agents/driver.ts) and lesson 5.4 put up to three scout
    // calls inside a single `research_destination` execution
    // (src/agents/scout.ts). The driver reserves before each call and reconciles
    // after (src/repo/reservation.ts), so a failed attempt's money is settled
    // call by call by the driver itself: refunded in full when a response body
    // came back, kept when nothing did, before the throw ever reaches this line.
    // What a retried step therefore costs is a fresh reservation per call it
    // makes again, each settled on its own terms, and never a second charge for
    // an attempt that already settled.
    //
    // `withRetry` wrapping the whole step is the wrap this harness has, over a
    // single agent-defined unit of work, and the two multi-call paths are each
    // built so that repeating the step does not repeat their spend: `selectDesk`
    // reads the decision it persisted rather than routing again
    // (src/repo/conversations.ts) and `runScouts` refunds a batch that never
    // reached the provider. A path that acquires a cost a retry cannot recover
    // is the one that would need the narrower wrap, around the call the 429 or
    // 5xx came from, and this branch has none.
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
      // The last thing between the model and her screen (src/sanitize.ts, lesson
      // 5.5). Applied here rather than inside the driver so that EVERY agent,
      // including one a later module writes, goes through it: a check the agent
      // applies to itself is a check the next agent forgets. `ask_user`'s
      // questions arrive here too, because the driver returns them as a
      // `message` step rather than as a kind of their own.
      //
      // What she is shown and what we record are the same string, and this
      // branch is why: a `message` step returns from here, so the text never
      // reaches the transcript append at the bottom of this loop, and the
      // `state` written below carries no assistant message at all. Nothing
      // stores the version before the check, so no later reader can quote her a
      // sentence she was never sent. That property is worth a sentence because
      // the obvious alternative, checking on the way out while recording what
      // the model wrote, would leave the two disagreeing for ever.
      //
      // `redactCurrency` FIRST and `sanitizeOutbound` second (src/channel.ts,
      // lesson 5.7). The order is not arbitrary: `sanitizeOutbound` may replace
      // a whole sentence with its solicitation refusal, and a redactor running
      // after that would be scanning text this repository wrote rather than text
      // the model wrote, which is the wrong input for it. Nothing about the
      // redaction can create a URL or a solicitation, so the reverse dependency
      // does not exist. A price she is shown therefore comes from the server
      // rather than from this text: from the card (`renderProposalCard`), which
      // the server builds from what the gates rehydrated out of
      // course.tool_results, or from the booking hand-off sentence
      // `completeIfLinkEmitted` writes above, which is built from
      // course.link_clicks and goes out through `sanitizeOutbound` alone.
      const outbound = step.text
        ? sanitizeOutbound(redactCurrency(step.text))
        : { ok: true as const, text: '' }
      if (!outbound.ok) {
        console.error(`turn ${claim.turnId}: outbound message rewritten`, outbound.reasons)
      }
      // Asked once, here, and passed to the one writer of that column on this
      // path. One row or none rather than the whole feed: this runs on every
      // completing turn and the answer is a boolean, so `hasEscalated` stops at
      // the first matching row (src/repo/agentEvents.ts, which also says why it
      // is scoped to the conversation rather than to this turn).
      const escalated = await hasEscalated(sql, claim.conversationId, claim.userId)
      await completeTurn(sql, claim, {
        // Null, not an empty string, on a blank answer: completeTurn writes a
        // row for anything that is not null, and an empty bubble in her
        // thread reads worse than nothing. A message the check emptied takes
        // the same road, so a reply that was nothing but a stripped link is no
        // bubble rather than an empty one.
        state, agentMessage: outbound.text || null, parked: true, spendMicros: turnSpend.total,
        // The turn ended `done` and no fail reason was written, because nothing
        // failed: it ran, it decided a person was needed, and it said so. What
        // changed is who is expected to act next, which is a property of the
        // conversation and not of the turn.
        ...(escalated ? { conversationStatus: 'escalated' as const } : {}),
      })
      /**
       * The other terminal exit, and the whole reason the label write lives in
       * the harness rather than in the eval that reads the rows back.
       *
       * `course.model_calls`, `course.messages` and `course.tool_results` answer
       * every question `TurnCounters` asks for ninety days and then stop, so a
       * counter that is not extracted at the moment a turn finishes is a counter
       * nobody can ever compute again (migration 0019 carries the argument).
       * Production turns are the ones that matter for that: an eval run can be
       * run again and a Tuesday in March cannot.
       *
       * AFTER `completeTurn`, never before, because the reply is half of what is
       * counted and `completeTurn` is what writes it to `course.messages`.
       *
       * Best effort inside `labelTurn` itself, which logs the turn id and
       * returns: a label write that failed must not lose a turn that succeeded,
       * and a turn with no row is honestly distinguishable from a turn whose
       * counters are zero.
       */
      await labelTurn(sql, {
        turnId: claim.turnId, conversationId: claim.conversationId, userId: claim.userId,
      })
      return
    }

    await heartbeat(sql, claim)
    /**
     * ONE writer of `course.tool_calls`, and it is not this file.
     *
     * `step.run` is the runner chain the agent was composed with, and the
     * ledger is the outermost link of that chain (`ledgerRunner`, src/tools.ts;
     * netlify/functions/run-turn-background.mts composes it). It writes the
     * pending row, decides whether the inner runner is called at all, replays a
     * stored result instead of running the tool a second time, and records the
     * outcome. A `beginToolCall` here as well would be a SECOND writer of the
     * same `(turn_id, call_id)`: the first insert wins, the second reads the row
     * this same worker wrote milliseconds earlier, sees `pending`, and reports
     * `ambiguous`, so every tool call on the composed path would fail its turn
     * with the supplier never called and a stuck row left for a person.
     *
     * The harness keeps the ENDING rather than the row: an ambiguous call is
     * still a turn-level decision, and `ledgerRunner` says so by throwing.
     * Caught here rather than left to `runTurn`'s catch, which would classify it
     * `unclassified` (src/errors.ts knows nothing about tool ledgers) and lose
     * the one reason in this module that genuinely needs a person
     * (src/repo/toolCalls.ts, src/sweeper.ts's runbook). Its own reason, not
     * 'fenced': fenced means another worker holds the claim and is alive to
     * finish the turn, which needs nobody's attention.
     *
     * Wrapped in `withHeartbeat` exactly like the agent call above: a real
     * supplier request can run past the staleness window, so heartbeat_at has to
     * keep moving while it is in flight and not only either side of it.
     */
    let result: unknown
    // The two feed rows a reader of `course.agent_events` counts against each
    // other: a `tool_start` with no `tool_done` beside it is the process that
    // died mid call, and it is the same fact `countSupplierCalls` reads off a
    // stuck `pending` ledger row (lesson 5.2). Best effort, so neither can take
    // a turn down, and named by the TOOL rather than by its input, because this
    // is a feed she may watch and a tool's input is the model's words.
    await recordAgentEvent(sql, {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
      kind: 'tool_start', detail: step.name,
    })
    try {
      result = await withHeartbeat(deps, claim, (signal) => step.run(signal))
    } catch (err) {
      if (!(err instanceof AmbiguousToolCallError)) throw err
      // One line, because `fail_reason` records the reason and nothing records
      // WHICH call: the person this ending is for has to find a `pending` row
      // by hand (src/repo/toolCalls.ts), and the tool's name is half of what
      // tells them whether the effect they are looking for is a wasted search
      // or a booking.
      console.error(`turn ${claim.turnId}: tool ${step.name} came back ambiguous`, err)
      // Before the ending is written, not after, because the closer reads
      // `turnSpend.total` and this exit returns past the `spend` call below. The
      // step's model call was reserved and reconciled by the driver already, so
      // the ceilings are right either way. What would be lost is the addition to
      // `turns.spend_usd_micros`, and a turn that ended ambiguous would read as
      // having paid for one model call fewer than it made. Safe to call here
      // because every driver step carries `alreadyRecorded: true`, so this only
      // accumulates the total and moves no money a second time.
      await spend(deps, claim, turnSpend, step)
      await failTurnUnlessLinkEmitted(deps, claim, state, turnSpend.total, 'ambiguous_tool_call')
      return
    }
    await recordAgentEvent(sql, {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
      kind: 'tool_done', detail: step.name,
    })
    await heartbeat(sql, claim)
    // Counted whether the tool ran or was replayed, which is a change from the
    // version that owned the ledger here and only billed the fresh branch. A
    // driver step is one MODEL call plus at most one tool execution, and the
    // model call happened either way; skipping it on a replay dropped a call
    // this turn really paid for out of `turns.spend_usd_micros`.
    await spend(deps, claim, turnSpend, step)

    state = {
      ...state,
      step: state.step + 1,
      messages: [
        ...state.messages,
        { role: 'assistant', content: step.assistantContent },
        { role: 'user', content: [toolResultBlock(step.callId, result)] },
      ],
    }
    progress.state = state
    await saveTurnState(sql, claim, state)
  }
}

/**
 * A tool's answer as the block that goes back to the model. `result` came back
 * from `step.run` typed `unknown`, and on a replay it came back out of a jsonb
 * column the type system never saw written, so the shape is checked rather than
 * asserted. A `ToolOutcome` carries the model's own error flag and that flag is
 * kept: `is_error: true` is how the model learns a gate refused its proposal
 * rather than reading a rejection as a result. Anything else is stringified,
 * which is what a test's counting runner returns.
 */
function toolResultBlock(callId: string, result: unknown): ToolResultBlock {
  if (isToolOutcome(result)) {
    return { type: 'tool_result', tool_use_id: callId, content: result.content, is_error: result.isError }
  }
  return { type: 'tool_result', tool_use_id: callId, content: JSON.stringify(result), is_error: false }
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
