import { liveClient } from '../../src/client.js'
import { newConversation, turn } from '../../src/conversation.js'
import { connect } from '../../src/db.js'
import { loadEnv } from '../../src/env.js'
import { finishTurn, loadTurnInput } from '../../src/repo/turns.js'
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
    const input = await loadTurnInput(sql, decision.turnId)
    if (!input) return new Response('nothing to do', { status: 200 })
    const result = await turn(
      newConversation(input.conversationId),
      input.message,
      liveClient(),
      mockRunner(new MockSupplier()),
      { deadlineMs: startedMs + BACKGROUND_BUDGET_MS },
    )
    await finishTurn(sql, input, result.text)
    console.log(`turn ${input.turnId}: ${result.outcome} in ${Date.now() - startedMs} ms`)
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
