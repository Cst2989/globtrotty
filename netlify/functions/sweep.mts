import postgres from 'postgres'
import { loadEnv } from '../../src/env.js'
import { sweep } from '../../src/sweeper.js'

/**
 * Tier 4: the scheduled sweeper. Netlify invokes this on the cron declared in `netlify.toml`
 * (`[functions."sweep"]` -> `schedule`), passing a `Request` whose body carries scheduling
 * metadata this function does not need.
 *
 * `sweep()` itself (src/sweeper.ts) is fully unit-tested against the real database in
 * `test/sweeper.test.ts` — it flips stale `running`/`queued` turns back to `queued` inside a
 * bounded, `SKIP LOCKED` batch. This file's only job is to fire a re-invocation for each
 * requeued turn, bounded to a small concurrency so one sweep tick cannot fan out hundreds of
 * simultaneous background invocations. A failed re-invocation is not fatal here either: the
 * turn is already durably `queued`, and the NEXT sweep (five minutes later) picks it up again.
 *
 * Thin wrapper, not unit-tested in this repo — see run-turn-background.mts's header for why.
 */

const CONCURRENCY = 5

export default async (): Promise<Response> => {
  const env = loadEnv(process.env)
  const sql = postgres(env.DATABASE_URL)

  let result: { requeued: string[]; backlog: number }
  try {
    result = await sweep(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }

  for (let i = 0; i < result.requeued.length; i += CONCURRENCY) {
    const batch = result.requeued.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map((turnId) => reinvoke(env, turnId)))
  }

  return new Response(
    JSON.stringify({ requeued: result.requeued.length, backlog: result.backlog }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function reinvoke(env: ReturnType<typeof loadEnv>, turnId: string): Promise<void> {
  await fetch(`${env.SITE_URL}/.netlify/functions/run-turn-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': env.WORKER_SHARED_SECRET },
    body: JSON.stringify({ turnId }),
  }).catch(() => {})   // best-effort: the next sweep will retry a turn that never restarted
}
