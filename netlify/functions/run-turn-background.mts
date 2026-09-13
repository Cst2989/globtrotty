import { makeDriver, provenanceFor } from '../../src/agents/driver.js'
import { cashierRunner } from '../../src/cashier.js'
import { liveClient } from '../../src/client.js'
import { TODAY } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { constraintsFromNotebook } from '../../src/gates/pipeline.js'
import { proposalRunner } from '../../src/gates/runner.js'
import { httpInvoke } from '../../src/invoke.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { loadNotebook } from '../../src/repo/notebook.js'
import type { Claim } from '../../src/repo/turns.js'
import { liveSuppliers } from '../../src/supplier/live.js'
import { authorize } from '../../src/tier3.js'
import {
  corpusRunner, doorRunner, ledgerRunner, notebookRunner, scoutRunner, scoutStayFrom,
  supplierRunner, type ToolRunner,
} from '../../src/tools.js'
import { runTurn, type Agent, type AgentContext } from '../../src/worker.js'

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
   * Eight wrappers, outermost first. The door checks the desk allowlist and
   * the schema before anything durable happens and fences the answer on the
   * way back (lesson 5.2); the ledger decides whether the tool runs at all
   * (lesson 3.4); the notebook records what she stated (lesson 5.2); the scout
   * runner sends up to three scouts at once under one reservation and joins
   * their briefs (lesson 5.4); the cashier re-quotes and emits the links
   * (lesson 4.6); the proposal runner puts a proposal through the gates
   * (lesson 4.5); the corpus records what a search returned (lesson 4.3); the
   * supplier runner makes the call. Each layer knows one thing, and the live
   * adapters get all of it by being handed to the innermost one.
   *
   * The scout sits INSIDE the ledger, so a replayed `research_destination`
   * replays the briefs rather than paying for three more model calls, and
   * inside the notebook because the ordering between those two is arbitrary:
   * neither reads what the other writes, so one order is picked and written
   * down here rather than left to whoever edits this file next.
   *
   * Built per agent step rather than once before `runTurn`, because two of these
   * wrappers fence their writes on a full `Claim` and a claim's `attempts` is
   * only known after `claimTurn` has taken the row, and because the notebook is
   * read fresh at every step: a patch `update_requirements` wrote on step 2 has
   * to be the notebook the gates judge step 3's proposal against. Taking both
   * from the `AgentContext` the harness hands us is the same value by
   * construction. Construction is a handful of closures and one small read, and
   * the supplier pair above, which is the part with any cost in it, is built
   * once.
   */
  const runnerFor = async (ctx: AgentContext): Promise<ToolRunner> => {
    const claim: Claim = {
      turnId: ctx.turnId, conversationId: ctx.conversationId, userId: ctx.userId,
      attempts: ctx.attempts, state: ctx.state,
    }
    // Her constraints, from the notebook this conversation actually stored.
    // Lesson 5.1 built an empty one on every step and every proposal recorded
    // `budget: not evaluated` because of it; 0015 gave the notebook a column and
    // this reads it.
    // The raw notebook is kept as well as the constraints: the gates want the
    // three fields `constraintsFromNotebook` keeps, and a scouting search wants
    // her nights and her party size, which it drops.
    const nb = await loadNotebook(sql, ctx.conversationId, ctx.userId)
    const notebook = constraintsFromNotebook(nb, TODAY)
    const gateCtx = {
      conversationId: claim.conversationId, userId: claim.userId, turnId: claim.turnId,
    }
    // The two that WRITE fenced take the same claim, because a worker this
    // driver has already lost cannot record a tool call and cannot append to
    // the corpus either; `gate_results` is an observation and is deliberately
    // not fenced (src/repo/gateResults.ts), so the proposal runner takes ids,
    // and the cashier takes the same three for the same reason.
    // The door is the planning desk's, and that is not a guess about which desk
    // `selectDesk` chose: the front desk publishes no tools at all
    // (`toolsForDesk('front')` is empty), so a front-desk step can never produce
    // a tool call for this chain to answer. The one desk that can reach a door
    // is the one named here.
    return doorRunner('planning', ledgerRunner(
      sql, claim,
      notebookRunner(
        sql,
        {
          conversationId: claim.conversationId, userId: claim.userId,
          // Derived from THIS step's transcript, not from a constant: a patch
          // written before any search is her words, and one written after a
          // tool result has landed is something the model worked out from text
          // we merely paid for (src/agents/driver.ts).
          source: () => provenanceFor(ctx),
          now: () => new Date(),
        },
        scoutRunner(
          sql,
          {
            // The SAME supplier pair the searches and the cashier are handed,
            // so a scout reads the payload the driver would have read. The stay
            // comes off the notebook this step already loaded, because
            // `research_destination` carries no dates and a hotel search needs
            // some.
            client, suppliers, stay: scoutStayFrom(nb, TODAY),
            conversationId: claim.conversationId, userId: claim.userId,
            turnId: claim.turnId, limits: DEFAULT_LIMITS, now: Date.now,
          },
          cashierRunner(
            sql, gateCtx,
            { suppliers, limits: DEFAULT_LIMITS, now: () => new Date() },
            proposalRunner(
              sql,
              { ...gateCtx, notebook, now: () => new Date() },
              // The searches ask for the SAME currency the gates expect, off the
              // same constraints object, so a corpus and the currency gate cannot
              // disagree by construction. Null until she states a budget, which
              // supplierRunner reads as TRIP_CURRENCY (lesson 4.5); a stored USD
              // budget makes both sides USD in one move.
              corpusRunner(sql, claim, supplierRunner(suppliers, notebook.currency)),
            ),
          ),
        ),
      ),
    ))
  }

  /**
   * The driver, from lesson 5.1: one invocation is one model call plus, if the
   * model asked for one, one tool execution. Until that lesson the whole of
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
   * `ledgerSink` as well would charge the same micros twice. It passes
   * `ctx.signal` into `callModel`, so a fence cancels its own call in flight.
   * Not the routing call: `classifyDesk` takes no signal (src/classify.ts), so
   * the first call of a turn's step 0 is the one call here a fence cannot stop.
   * It is in README's residuals with an owner.
   */
  const agent: Agent = async (ctx) => makeDriver({
    sql,
    client,
    run: await runnerFor(ctx),
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
