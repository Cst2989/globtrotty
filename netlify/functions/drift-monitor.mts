import postgres from 'postgres'
import Anthropic from '@anthropic-ai/sdk'
import { loadEnv } from '../../src/env.js'
import { runDriftMonitor } from '../../src/monitor/drift.js'
import { LogNotifier } from '../../src/notify.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'

/**
 * Tier 4: the nightly drift monitor. Netlify invokes this on the cron
 * declared in `netlify.toml` (`[functions."drift-monitor"]` -> `schedule`),
 * passing a `Request` whose body carries scheduling metadata this function
 * does not need.
 *
 * `runDriftMonitor()` itself (src/monitor/drift.ts) is fully unit-tested
 * against the real database in `test/drift.test.ts` — it fingerprints one
 * golden call per seat, diffs it against the previous run, diffs the newest
 * real request shape against what the repo builds today, and charges every
 * call to the fixed ops user rather than a traveller. This file's only job
 * is to build the real transport (exactly as `test/driver.live.test.ts`'s
 * `transport()` does) and the real notifier, and report the counts.
 *
 * Thin wrapper, not unit-tested in this repo — see run-turn-background.mts's
 * header for why.
 */
export default async (): Promise<Response> => {
  const env = loadEnv(process.env)
  const sql = postgres(env.DATABASE_URL)
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const transport = {
    create: (req: unknown) => client.messages.create(req as never) as Promise<unknown>,
    countTokens: (req: unknown) =>
      client.messages.countTokens(req as never) as Promise<{ input_tokens: number }>,
  }

  let result: Awaited<ReturnType<typeof runDriftMonitor>>
  try {
    result = await runDriftMonitor({
      sql, transport, limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(),
    })
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response(
    JSON.stringify({
      alarms: result.alarms.length, runs: result.runs.length, skipped: result.skipped.length,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
