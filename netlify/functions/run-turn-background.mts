import postgres from 'postgres'
import { z } from 'zod'
import { loadEnv } from '../../src/env.js'
import { runTurn, echoAgent } from '../../src/worker.js'
import type { Limits } from '../../src/engine.js'

/**
 * Tier 3: the background function. Netlify Functions v2 (esbuild-bundled, `.mts`) hand every
 * function a standard Fetch `Request` and expect a standard `Response` back — no framework
 * types required, so this file has no dependency on a Next.js route-handler shape or on
 * `@netlify/functions`, neither of which is installed in this repo yet.
 *
 * This endpoint is publicly reachable and starts a run, so it is an uncapped-spend endpoint
 * unless authenticated. The check below is the entire authentication story: a shared secret,
 * compared before anything else happens, that must be set identically here and on whatever
 * calls this endpoint (`submitMessage`'s `invoke`, and the sweeper's re-invocation).
 *
 * This file is intentionally a THIN WRAPPER: every property that matters (claiming, fencing,
 * idempotency, atomic completion, fail-closed spend) is proven by `test/worker.test.ts`
 * against `runTurn` directly. There is no Netlify-hosted test harness in this repo, so this
 * file itself is exercised only by manual/staging verification, never by `pnpm test`.
 *
 * `echoAgent` is wired in directly, matching the rest of plan 1 — a later plan swaps it for
 * the real agent fleet behind the same `Agent` type and nothing else here changes.
 */

// Same figures used throughout the harness's own tests ($8 conversation / $15 daily /
// $50 global ceiling, 24-step cap). No config module exists yet for production limits;
// when one lands, this constant moves there rather than being redefined per entrypoint.
const LIMITS: Limits = {
  conversationCeilingMicros: 8_000_000n,
  dailyCeilingMicros: 15_000_000n,
  globalCeilingMicros: 50_000_000n,
  maxSteps: 24,
}

// Background functions on Netlify run up to 15 minutes; leave headroom so a turn that would
// otherwise be killed mid-step instead persists state and reinvokes (see decideNext's
// `continue_later` path).
const BACKGROUND_BUDGET_MS = 14 * 60_000

const Body = z.object({ turnId: z.string().min(1) })

export default async (req: Request): Promise<Response> => {
  const env = loadEnv(process.env)

  const provided = req.headers.get('x-worker-secret')
  if (!provided || provided !== env.WORKER_SHARED_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return new Response('bad request', { status: 400 })
  }
  const { turnId } = parsed.data

  const startedMs = Date.now()
  const sql = postgres(env.DATABASE_URL)
  try {
    await runTurn(
      {
        sql,
        limits: LIMITS,
        agent: echoAgent,
        now: () => Date.now(),
        deadlineMs: () => startedMs + BACKGROUND_BUDGET_MS,
        reinvoke: (id) => reinvoke(env, id),
      },
      turnId,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}

async function reinvoke(env: ReturnType<typeof loadEnv>, turnId: string): Promise<void> {
  await fetch(`${env.SITE_URL}/.netlify/functions/run-turn-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': env.WORKER_SHARED_SECRET },
    body: JSON.stringify({ turnId }),
  })
}
