import postgres from 'postgres'
import Anthropic from '@anthropic-ai/sdk'
import { loadEnv } from '../../src/env.js'
import { runDriftMonitor } from '../../src/monitor/drift.js'
import { authorise } from '../../src/monitor/authorise.js'
import { LogNotifier } from '../../src/notify.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'

/**
 * Tier 4: the nightly drift monitor. Netlify invokes this on the cron
 * declared in `netlify.toml` (`[functions."drift-monitor"]` -> `schedule`),
 * passing a `Request` whose body carries scheduling metadata (Netlify's own
 * `{ next_run }` shape) rather than our own shared secret — see
 * `src/monitor/authorise.ts` for the two paths this endpoint accepts.
 *
 * This is an uncapped-spend endpoint (every call it triggers reserves and
 * spends real money against `OPS_USER_ID`) unless authenticated, exactly
 * like `run-turn-background.mts` — the check below is copied from that
 * file's authentication story, widened only to also accept Netlify's own
 * scheduler, which cannot attach our custom header.
 *
 * `runDriftMonitor()` itself (src/monitor/drift.ts) is fully unit-tested
 * against the real database in `test/drift.test.ts` — it fingerprints one
 * golden call per seat, diffs it against the previous run, diffs the newest
 * real (non-ops) request shape against what the repo builds today, and
 * charges every call to the fixed ops user rather than a traveller. This
 * file's only job is to authorise the request, build the real transport
 * (exactly as `test/driver.live.test.ts`'s `transport()` does) and the real
 * notifier, and report the counts.
 *
 * Thin wrapper, not unit-tested in this repo — see run-turn-background.mts's
 * header for why.
 */
export default async (req: Request): Promise<Response> => {
  const env = loadEnv(process.env)

  // Read once, up front: `authorise` needs the body, and a `Request`'s body
  // stream can only be consumed once. A malformed or missing body (a plain
  // secret-bearing invocation carries none) parses to `null`, which
  // `authorise` treats as "no scheduled marker" rather than throwing.
  const body: unknown = await req.json().catch(() => null)
  if (!authorise({ headers: req.headers, body }, env.WORKER_SHARED_SECRET)) {
    return new Response('unauthorized', { status: 401 })
  }

  const sql = postgres(env.DATABASE_URL)
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const transport = {
    create: (body: unknown) => client.messages.create(body as never) as Promise<unknown>,
    countTokens: (body: unknown) =>
      client.messages.countTokens(body as never) as Promise<{ input_tokens: number }>,
  }

  let result: Awaited<ReturnType<typeof runDriftMonitor>>
  try {
    result = await runDriftMonitor({
      sql, transport, limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(),
    })
  } finally {
    await sql.end({ timeout: 5 })
  }

  // Best-effort visibility into what a nightly run found, like sweep.mts does
  // for reaped crash-loop turns — no structured logging pipeline exists yet.
  console.error('drift-monitor: run complete', {
    alarms: result.alarms.length, runs: result.runs.length, skipped: result.skipped.length,
  })

  return new Response(
    JSON.stringify({
      alarms: result.alarms.length, runs: result.runs.length, skipped: result.skipped.length,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
