import { liveClient } from '../../src/client.js'
import { newConversation, turn } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { constraintsFromNotebook } from '../../src/gates/pipeline.js'
import { proposalRunner } from '../../src/gates/runner.js'
import { isFailReason } from '../../src/engine.js'
import { httpInvoke } from '../../src/invoke.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { emptyNotebook } from '../../src/notebook.js'
import { fencedModelCallSink, ledgerSink, readSpendFailClosed } from '../../src/repo/spend.js'
import { liveSuppliers } from '../../src/supplier/live.js'
import { authorize } from '../../src/tier3.js'
import { corpusRunner, ledgerRunner, supplierRunner, type ToolRunner } from '../../src/tools.js'
import { runTurn, type Agent } from '../../src/worker.js'

/**
 * Tier 3: the background function. Netlify Functions v2 (esbuild bundled, .mts)
 * hand every function a standard Fetch Request and expect a standard Response
 * back, so this file needs no framework types.
 *
 * It is intentionally a thin wrapper. Everything that decides whether the call
 * is allowed lives in src/tier3.ts and is unit tested there, because there is no
 * Netlify test harness in this repository and a file that only staging can
 * exercise is a file whose bugs reach production first.
 */

// Background functions on Netlify run up to fifteen minutes. The headroom is
// what lesson 2.3's deadline check spends: a turn that would be killed mid step
// stops early instead.
export const BACKGROUND_BUDGET_MS = 14 * 60_000

export default async (req: Request): Promise<Response> => {
  const env = loadEnv(process.env)
  const decision = authorize(
    { secret: req.headers.get('x-worker-secret'), body: await req.json().catch(() => null) },
    env.WORKER_SHARED_SECRET,
  )
  if (decision.kind === 'reject') {
    return new Response(decision.body, { status: decision.status })
  }

  const startedMs = Date.now()
  const sql = connect(env.DATABASE_URL, 2)

  /**
   * Module 1's whole `turn()` as ONE agent step. That is the honest shape today:
   * the driver decides and acts inside its own loop, so the harness can only see
   * a turn start and a turn end, and a crash lands between turns rather than
   * between model calls. Module 5 splits it into the driver's own steps; nothing
   * in the harness changes when it does, which is the point of the Agent type.
   */
  const driverAgent: Agent = async ({ state, conversationId, userId, turnId, attempts, signal }) => {
    const last = [...state.messages].reverse().find((m) => m.role === 'user')
    // ledgerRunner (src/tools.ts) fences its writes on a full Claim, not a bare
    // turn id, since lesson 3.4's fix round: a superseded worker must not be
    // able to write tool-call intent for a turn it no longer owns. Rebuilt here
    // from the pieces AgentContext carries rather than handed the harness's own
    // Claim object, which would let this driver bypass the loop's own closers.
    const claim = { turnId, conversationId, userId, attempts, state }

    // A `turn()` running fourteen minutes' worth of classify/extract/tool-loop
    // calls had no boundary this driver could reach mid-call until lesson 4.2
    // threaded an abort signal through src/loop.ts itself. It has one now: the
    // guards below still refuse to START the next call, and the same signal,
    // handed to `turn()` below, cancels the model call and the supplier fetch
    // already in flight. `classify` and `extract` are the one exception and
    // are deliberately not given it (src/conversation.ts), so a fence landing
    // during one of those two short cheap-seat calls is still paid for.
    //
    // What cancelling costs, said plainly: the provider may already have
    // generated most of a reply and may already have charged for it, and
    // `callAndRecord` (src/metered.ts) records only what CAME BACK, so an
    // aborted call writes no course.model_calls row, no daily_usage increment
    // and no conversations.spend_usd_micros increment. That charge is
    // invisible to every later ceiling check. It is not closed here and
    // course.model_calls has no column that could name it; module 5's
    // reserve-before-call is where a call becomes countable before it is made.
    //
    // fencedModelCallSink (src/repo/spend.ts) answers the OTHER case, a call
    // that returned into a fence: it records every such call unconditionally,
    // since it already happened and already cost real money by the time the
    // sink runs, and only refuses the NEXT one. It never sees a cancelled
    // call, because a cancelled call never reaches a sink.
    //
    // An aborted model call does not fail this turn either. It classifies as
    // `unclassified` (src/errors.ts), the driver turns that into a `fail`
    // step, and `withHeartbeat`'s check after `work()` settles (src/worker.ts)
    // throws the captured FencedError before `runTurn` can reach the fail
    // branch, so nothing is stamped on a turn this worker no longer owns. That
    // post-check is load bearing here in a way it was not before 4.2.
    const record = fencedModelCallSink(ledgerSink(sql, { userId, conversationId, turnId }), signal)
    // Her constraints, DERIVED through the one mapper rather than written here
    // as three literal nulls. Nothing on this branch stores a notebook: `turn()`
    // builds an empty one at the top of every turn (src/conversation.ts), fills
    // it from her message and drops it when the turn ends, and this runner is
    // constructed outside `turn()` in any case. So this call receives an empty
    // notebook and every field really is null, which is the same three values
    // the literal had and a different claim: this line reads a notebook, and
    // the day the conversation stores one it reads that one instead and nothing
    // else in the chain moves. Module 5.2 puts the tool registry inside the
    // harness, where the turn's own notebook is in scope, and this becomes
    // constraintsFromNotebook(conversation.notebook).
    //
    // What that costs today, on the record: the pipeline writes `budget` and
    // `dates` as not evaluated WITH A REASON on every proposal a live run
    // produces, rather than as passes. It is the only path a reader can run,
    // which is why lesson 4.5's own proof drives proposalRunner, this exact
    // seam, with a real budget in it (test/gate-pipeline.test.ts).
    const notebook = constraintsFromNotebook(emptyNotebook())
    // Four wrappers, outermost first. The ledger decides whether the tool runs
    // at all (lesson 3.4); the proposal runner puts a proposal through the
    // gates (lesson 4.5); the corpus records what a search returned (lesson
    // 4.3); the supplier runner makes the call. Each layer knows one thing, and
    // the live adapters get all of it by being handed to the innermost one.
    // The two that WRITE fenced take the same claim, because a worker this
    // driver has already lost cannot record a tool call and cannot append to
    // the corpus either; `gate_results` is an observation and is deliberately
    // not fenced (src/repo/gateResults.ts), so the proposal runner takes ids.
    const baseRunner = ledgerRunner(
      sql, claim,
      proposalRunner(
        sql,
        { conversationId, userId, turnId, notebook, now: () => new Date() },
        // The searches ask for the SAME currency the gates expect, off the same
        // constraints object, so a corpus and the currency gate cannot disagree
        // by construction. Null on this branch, which supplierRunner reads as
        // TRIP_CURRENCY (lesson 4.5); a stored USD budget makes both sides USD
        // in one move.
        corpusRunner(sql, claim, supplierRunner(liveSuppliers().suppliers, notebook.currency)),
      ),
    )
    const runner: ToolRunner = async (name, input, callId, sig) => {
      // A tool call is the opposite case: checked BEFORE it starts, so a
      // fence refuses to run the tool at all rather than recording one that
      // already fired. Nothing has happened yet at this point, unlike the
      // model call above, so there is no row to lose by refusing here.
      if (signal.aborted) throw signal.reason
      return baseRunner(name, input, callId, sig)
    }

    const result = await turn(
      newConversation(conversationId),
      last?.content ?? '',
      liveClient(),
      // Every supplier call goes through the ledger, so a kill mid search costs
      // one call and never two (lesson 3.4).
      runner,
      {
        deadlineMs: startedMs + BACKGROUND_BUDGET_MS,
        record,
        readSpend: () => readSpendFailClosed(sql, userId, conversationId),
        // Closed in lesson 4.2: the fence now reaches a call already in flight,
        // not only the next one. README.md's residual paragraph moves with it.
        signal,
      },
    )
    // continue_later is neither a fail reason nor a message: the driver's own
    // budget (src/loop.ts's toolLoop, checked against the same deadlineMs)
    // ran out mid-turn, not the work itself. Mapping it into the message
    // branch would record an unfinished turn as `done` with a blank reply,
    // outside both the live-turn index and the sweeper's predicate, with
    // nothing left able to pick it back up.
    //
    // It still reports what it spent getting there, like every other branch:
    // a restart pays for classify, extract and every tool step again, and a
    // turn that continued three times has to end with all three attempts on
    // its own row.
    if (result.outcome === 'continue_later') {
      return { kind: 'continue_later', costMicros: result.costMicros, alreadyRecorded: true }
    }
    // What `turn()` itself spent, on every branch, with `alreadyRecorded` set:
    // `ledgerSink` has already added each of those model calls to
    // course.conversations and course.daily_usage as it made them, so the
    // harness must not charge them a second time, but `turns.spend_usd_micros`
    // is written by nothing else at all (completeTurn, failTurn and
    // releaseForContinuation, src/repo/turns.ts) and reporting 0n here left it
    // reading as free for every turn tier 3 ran.
    if (isFailReason(result.outcome)) {
      return {
        kind: 'fail', reason: result.outcome, text: result.text || null,
        costMicros: result.costMicros, alreadyRecorded: true,
      }
    }
    return { kind: 'message', text: result.text, costMicros: result.costMicros, alreadyRecorded: true }
  }

  try {
    try {
      await runTurn(
        {
          sql,
          limits: DEFAULT_LIMITS,
          agent: driverAgent,
          now: Date.now,
          deadlineMs: () => startedMs + BACKGROUND_BUDGET_MS,
          reinvoke: httpInvoke(env),
        },
        decision.turnId,
      )
      console.log(`turn ${decision.turnId}: finished in ${Date.now() - startedMs} ms`)
    } catch (err) {
      // Every classified failure is already recorded on the row by runTurn's
      // own catch before it re-throws; this catch exists only so THIS
      // function still answers 200. The alternative, no catch at all, was the
      // pre-3.6 shape's whole reason for answering 200 on a fenced retry
      // ("nothing went wrong, somebody else has the work") and this lesson's
      // rewrite dropped it: a rotated key or a database hiccup now recorded
      // itself correctly and then made Netlify treat the invocation as a
      // platform-level failure and retry it, on top of a row that already
      // explains itself.
      console.error(`turn ${decision.turnId} failed`, err)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
