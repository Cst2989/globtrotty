import { liveClient } from '../../src/client.js'
import { newConversation, turn } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { isFailReason } from '../../src/engine.js'
import { ledgerSink, readSpendFailClosed } from '../../src/repo/spend.js'
import { claimTurn, completeTurn, failTurn, loadTurnInput } from '../../src/repo/turns.js'
import { MockSupplier } from '../../src/supplier/mock.js'
import { authorize } from '../../src/tier3.js'
import { mockRunner } from '../../src/tools.js'

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
  try {
    // Claim first, load second. The claim is the exclusion; the load is just a
    // read. A second invocation of this same turn, from Netlify's own retry or
    // from lesson 3.5's sweeper, gets null here and walks away without running
    // anything, which is why it answers 200 rather than an error: nothing went
    // wrong, somebody else has the work.
    const claim = await claimTurn(sql, decision.turnId)
    if (!claim) return new Response('already claimed', { status: 200 })
    const input = await loadTurnInput(sql, decision.turnId)
    // No message to run: the claim above already set 'running' and is not
    // released here, so this turn is left for lesson 3.2's heartbeat sweeper
    // to reap once that heartbeat goes stale, rather than walked back to
    // 'queued' for an immediate retry.
    if (!input) return new Response('nothing to do', { status: 200 })
    const result = await turn(
      newConversation(input.conversationId),
      input.message,
      liveClient(),
      mockRunner(new MockSupplier()),
      {
        deadlineMs: startedMs + BACKGROUND_BUDGET_MS,
        record: ledgerSink(sql, { userId: input.userId, conversationId: input.conversationId, turnId: input.turnId }),
        readSpend: () => readSpendFailClosed(sql, input.userId, input.conversationId),
      },
    )
    // Two ways out, and the reason decides which. Every outcome the engine can
    // name (src/engine.ts's FAIL_REASONS) is a failure with that reason on the
    // row; 'done', 'max_tokens' and 'continue_later' are the turn ending with an
    // answer. `parked: true` because the agency has said its piece and she holds
    // the next move; lesson 3.5's sweeper must never resurrect that.
    //
    // 0n on both branches, not result.costMicros: this path's ledgerSink already
    // recorded every model call and incremented conversation and daily spend as
    // it went (lesson 2.6), so adding the total again here would double-count it
    // on the turn row. Lesson 3.6's worker, whose agent steps are not metered by
    // a sink, is what passes a real number.
    if (isFailReason(result.outcome)) {
      await failTurn(sql, claim, result.outcome, 0n, result.text === '' ? null : result.text)
    } else {
      await completeTurn(sql, claim, {
        state: { step: result.steps }, agentMessage: result.text === '' ? null : result.text,
        parked: true, spendMicros: 0n,
      })
    }
    console.log(`turn ${input.turnId}: ${result.outcome} in ${Date.now() - startedMs} ms`)
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
