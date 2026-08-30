import { liveClient } from '../../src/client.js'
import { newConversation, turn } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { isFailReason } from '../../src/engine.js'
import { httpInvoke } from '../../src/invoke.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { ledgerSink, readSpendFailClosed } from '../../src/repo/spend.js'
import { MockSupplier } from '../../src/supplier/mock.js'
import { authorize } from '../../src/tier3.js'
import { ledgerRunner, mockRunner } from '../../src/tools.js'
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
  const driverAgent: Agent = async ({ state, conversationId, userId, turnId, attempts }) => {
    const last = [...state.messages].reverse().find((m) => m.role === 'user')
    // ledgerRunner (src/tools.ts) fences its writes on a full Claim, not a bare
    // turn id, since lesson 3.4's fix round: a superseded worker must not be
    // able to write tool-call intent for a turn it no longer owns. Rebuilt here
    // from the pieces AgentContext carries rather than handed the harness's own
    // Claim object, which would let this driver bypass the loop's own closers.
    const claim = { turnId, conversationId, userId, attempts, state }
    const result = await turn(
      newConversation(conversationId),
      last?.content ?? '',
      liveClient(),
      // Every supplier call goes through the ledger, so a kill mid search costs
      // one call and never two (lesson 3.4).
      ledgerRunner(sql, claim, mockRunner(new MockSupplier())),
      {
        deadlineMs: startedMs + BACKGROUND_BUDGET_MS,
        record: ledgerSink(sql, { userId, conversationId, turnId }),
        readSpend: () => readSpendFailClosed(sql, userId, conversationId),
      },
    )
    // 0n on both branches: ledgerSink already recorded every model call and
    // incremented conversation and daily spend as it went, so a total here would
    // be the same money counted twice.
    if (isFailReason(result.outcome)) {
      return { kind: 'fail', reason: result.outcome, text: result.text || null, costMicros: 0n }
    }
    return { kind: 'message', text: result.text, costMicros: 0n }
  }

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
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
