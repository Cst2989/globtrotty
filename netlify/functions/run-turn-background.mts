import { makeDriver } from '../../src/agents/driver.js'
import { cashierRunner } from '../../src/cashier.js'
import { liveClient } from '../../src/client.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { constraintsFromNotebook } from '../../src/gates/pipeline.js'
import { proposalRunner } from '../../src/gates/runner.js'
import { httpInvoke } from '../../src/invoke.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { emptyNotebook } from '../../src/notebook.js'
import type { Claim } from '../../src/repo/turns.js'
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

  // ONE pair for the whole invocation, built before anything runs and shared by
  // the searches and by the cashier's re-quote. A cashier re-quoting against a
  // different supplier instance than the one that searched would be checking one
  // system's price against another's, and the mock's own `quote` keeps the
  // results of the search it just ran (src/supplier/mock.ts), so two instances
  // would not even be asking the same question.
  const suppliers = liveSuppliers().suppliers
  const client = liveClient()

  /**
   * The five wrappers, outermost first: the ledger decides whether the tool runs
   * at all (lesson 3.4), the cashier re-quotes and emits the links (lesson 4.6),
   * the proposal runner puts a proposal through the gates (lesson 4.5), the
   * corpus records what a search returned (lesson 4.3), the supplier runner
   * makes the call. Each layer knows one thing, and the live adapters get all of
   * it by being handed to the innermost one.
   *
   * Built per agent step rather than once before `runTurn`, because two of these
   * wrappers fence their writes on a full `Claim` and a claim's `attempts` is
   * only known after `claimTurn` has taken the row. Reading the turn a second
   * time here to guess at it would be a second reader of a number the harness
   * already owns; taking it from the `AgentContext` the harness hands us is the
   * same value by construction. Construction is a handful of closures, and the
   * supplier pair above, which is the part with any cost in it, is built once.
   */
  const runnerFor = (claim: Claim): ToolRunner => {
    // Her constraints, DERIVED through the one mapper rather than written here
    // as three literal nulls. Nothing on this branch stores a notebook: the
    // driver renders "nothing yet" into its prompt on every step
    // (src/agents/driver.ts) and this runner is built outside it in any case. So
    // this call receives an empty notebook and every field really is null, which
    // is the same three values the literal had and a different claim: this line
    // reads a notebook, and the day the conversation stores one it reads that
    // one instead and nothing else in the chain moves. Lesson 5.2 persists the
    // notebook on the conversation and this becomes a read of that row.
    //
    // What that costs today, on the record: the pipeline writes `budget` and
    // `dates` as not evaluated WITH A REASON on every proposal a live run
    // produces, rather than as passes. `npm run trip` (scripts/trip.ts) derives
    // its constraints the same way from the same empty notebook, so that is
    // both of the paths a reader can run, which is why lesson 4.5's own proof
    // drives proposalRunner, this exact seam, with a real budget in it
    // (test/gate-pipeline.test.ts).
    const notebook = constraintsFromNotebook(emptyNotebook())
    const gateCtx = {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
    }
    // The two that WRITE fenced take the same claim, because a worker this
    // driver has already lost cannot record a tool call and cannot append to
    // the corpus either; `gate_results` is an observation and is deliberately
    // not fenced (src/repo/gateResults.ts), so the proposal runner takes ids,
    // and the cashier takes the same three for the same reason.
    return ledgerRunner(
      sql, claim,
      cashierRunner(
        sql, gateCtx,
        { suppliers, limits: DEFAULT_LIMITS, now: () => new Date() },
        proposalRunner(
          sql,
          { ...gateCtx, notebook, now: () => new Date() },
          // The searches ask for the SAME currency the gates expect, off the same
          // constraints object, so a corpus and the currency gate cannot disagree
          // by construction. Null on this branch, which supplierRunner reads as
          // TRIP_CURRENCY (lesson 4.5); a stored USD budget makes both sides USD
          // in one move.
          corpusRunner(sql, claim, supplierRunner(suppliers, notebook.currency)),
        ),
      ),
    )
  }

  /**
   * The driver, from lesson 5.1: one invocation is one model call plus, if the
   * model asked for one, one tool execution. Until this lesson the whole of
   * `turn()` ran inside a single agent step, so the harness could see a turn
   * start and a turn end and nothing in between, and a crash landed between
   * turns rather than between model calls. Now the harness owns every step, and
   * a turn handed back for want of wall clock resumes from the transcript in
   * `course.turns.state` instead of starting the conversation again.
   *
   * Closed at lesson 5.1. A call is counted BEFORE it is made: the driver
   * reserves an upper bound against course.conversations and
   * course.daily_usage, then reconciles the real figure after. A call that is
   * aborted mid flight leaves the reservation debited, which is the
   * conservative direction, because the provider may have generated and
   * billed a response we never saw. `src/agents/driver.ts` refunds in full
   * only when an error BODY came back, since an error body carries no usage.
   *
   * `fencedModelCallSink` and `ledgerSink` left this file with `turn()`. The
   * driver records its span through `pgSink`, which moves no money, and takes
   * its own door to the ledger through `reserve` and `reconcile`; handing it
   * `ledgerSink` as well would charge the same micros twice. It checks
   * `ctx.signal` through `callModel`, so a fence still cancels a call in flight.
   */
  const agent: Agent = async (ctx) => makeDriver({
    sql,
    client,
    run: runnerFor({
      turnId: ctx.turnId, conversationId: ctx.conversationId, userId: ctx.userId,
      attempts: ctx.attempts, state: ctx.state,
    }),
    limits: DEFAULT_LIMITS,
    now: Date.now,
  })(ctx)

  try {
    try {
      await runTurn(
        {
          sql,
          limits: DEFAULT_LIMITS,
          agent,
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
