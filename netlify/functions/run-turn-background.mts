import { liveClient } from '../../src/client.js'
import { newConversation, turn } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { isFailReason } from '../../src/engine.js'
import { ledgerSink, readSpendFailClosed } from '../../src/repo/spend.js'
import { claimTurn, finishTurn, loadTurnInput } from '../../src/repo/turns.js'
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
    // Every outcome the engine can name (src/engine.ts's FAIL_REASONS) is
    // passed through to `turns.fail_reason`; 'done', 'max_tokens' and
    // 'continue_later' are not fail reasons and finishTurn records nothing
    // for them, exactly as before. The ceiling denial is the one reason that
    // also leaves the same record behind tier 2's own (src/handler.ts).
    await finishTurn(sql, input, result.text, isFailReason(result.outcome) ? result.outcome : undefined)
    console.log(`turn ${input.turnId}: ${result.outcome} in ${Date.now() - startedMs} ms`)
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
