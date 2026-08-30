import { connect } from '../../src/db.js'
import { loadEnv, type Env } from '../../src/env.js'
import { sweep, type SweepResult } from '../../src/sweeper.js'

/**
 * Tier 4: the scheduled sweeper. Netlify invokes this on the cron in
 * netlify.toml, passing a Request whose body carries scheduling metadata this
 * function does not read.
 *
 * A thin wrapper, and not unit tested here, for the same reason
 * run-turn-background.mts is not: there is no Netlify test harness in this
 * repository. Everything it decides lives in src/sweeper.ts and is tested there
 * against a real database.
 *
 * It calls loadEnv, which insists on ANTHROPIC_API_KEY even though tier 4 makes
 * no model call. That is deliberate: one env contract for the whole deploy is
 * worth more than a second, narrower one that drifts, and a site that cannot run
 * a turn has nothing worth sweeping for.
 *
 * Its only job beyond calling sweep() is to fire an invocation for each requeued
 * turn, a few at a time, so one tick cannot fan out a hundred simultaneous
 * background functions at a provider that may be exactly why they stalled. A
 * failed re-invocation is not fatal: the turn is already durably queued, and the
 * next sweep sees it again.
 */
const CONCURRENCY = 5

export default async (): Promise<Response> => {
  const env = loadEnv(process.env)
  const sql = connect(env.DATABASE_URL, 2)

  let result: SweepResult
  try {
    result = await sweep(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }

  // Two failures worth a line in the log, because neither can be inferred from
  // the requeue count and both mean a turn ended without doing its work.
  if (result.reaped.length > 0) console.error('sweep: reaped crash-loop turns', result.reaped)
  if (result.stalled.length > 0) console.error('sweep: reaped turns with no message', result.stalled)

  for (let i = 0; i < result.requeued.length; i += CONCURRENCY) {
    await Promise.all(result.requeued.slice(i, i + CONCURRENCY).map((turnId) => reinvoke(env, turnId)))
  }

  return new Response(
    JSON.stringify({
      requeued: result.requeued.length,
      reaped: result.reaped.length,
      stalled: result.stalled.length,
      backlog: result.backlog,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** The same POST tier 2 makes, with the same shared secret (lesson 2.2). */
async function reinvoke(env: Env, turnId: string): Promise<void> {
  await fetch(`${env.SITE_URL}/.netlify/functions/run-turn-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-worker-secret': env.WORKER_SHARED_SECRET },
    body: JSON.stringify({ turnId }),
    // Best effort on purpose: the turn is already queued, so the next sweep is
    // the retry, and throwing here would fail a tick that did its real work.
  }).catch(() => {})
}
