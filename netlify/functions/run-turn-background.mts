import { timingSafeEqual } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { loadEnv, loadOptionalEnv } from '../../src/env.js'
import { runTurn } from '../../src/worker.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { LogNotifier } from '../../src/notify.js'
import { invokeBackground } from '../../src/invoke.js'
import { routeAgent } from '../../src/agents/route.js'
import type { Transport } from '../../src/model/client.js'
import { KiwiSupplier } from '../../src/supplier/kiwi.js'
import { SearchApiHotels } from '../../src/supplier/searchapi.js'
import { MockSupplier } from '../../src/supplier/mock.js'

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
 * `routeAgent` (src/agents/route.ts) is the real agent fleet — intake (plan 5 Task 5, replacing
 * the old front desk) then driver, wired to the real Anthropic/Jev transports and the real
 * flight/hotel suppliers.
 * `echoAgent` stays exported from `worker.ts`, unused here, purely so `test/worker.test.ts`
 * keeps exercising the harness without a model; this handler never imports it.
 */

// Background functions on Netlify run up to 15 minutes; leave headroom so a turn that would
// otherwise be killed mid-step instead persists state and reinvokes (see decideNext's
// `continue_later` path).
const BACKGROUND_BUDGET_MS = 14 * 60_000

const Body = z.object({ turnId: z.string().min(1) })

/**
 * Constant-time secret comparison. `timingSafeEqual` throws on a length mismatch rather than
 * returning false, and a naive `provided.length === expected.length` short-circuit ahead of it
 * would itself leak the secret's length through timing — so the length check has to fail
 * closed into the exact same rejection as a content mismatch, never a distinguishable path.
 */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * `JEV_KEY` goes through the same optional door `GOOGLE_SEARCH_API` does
 * (`loadOptionalEnv`, src/env.ts) because that function's contract is "this key may be ABSENT
 * from the environment without that being a config error" — but unlike search, which degrades
 * to a mock, intake (src/agents/intake.ts) is now the front door for every first message and has
 * no fallback without it. So a missing key fails loudly HERE, at construction, exactly like a
 * missing `DATABASE_URL` does in `loadEnv` — never silently inside the first real conversation.
 */
function throwMissing(key: string): never {
  throw new Error(`run-turn: ${key} is not set — intake cannot run without it`)
}

export default async (req: Request): Promise<Response> => {
  const env = loadEnv(process.env)

  // Both rejection paths inside secretsMatch (wrong length, wrong content) collapse to this
  // single boolean, so this one call site is the only place a 401 is constructed — a length
  // mismatch and a content mismatch are byte-for-byte the same response.
  if (!secretsMatch(req.headers.get('x-worker-secret'), env.WORKER_SHARED_SECRET)) {
    return new Response('unauthorized', { status: 401 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return new Response('bad request', { status: 400 })
  }
  const { turnId } = parsed.data

  // GOOGLE_SEARCH_API is optional (src/env.ts's loadOptionalEnv): a real deploy that has not
  // set it still boots, but hotel search silently degrades to fixtures unless flagged loudly
  // here — the one place that log line can be written once per invocation.
  const searchKey = loadOptionalEnv(process.env, 'GOOGLE_SEARCH_API')
  if (!searchKey) {
    console.error('run-turn: GOOGLE_SEARCH_API unset — hotels are MOCK')
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const transport: Transport = {
    create: (req, options) => client.messages.create(req as never, options as never) as Promise<unknown>,
    countTokens: (req) => client.messages.countTokens(req as never) as Promise<{ input_tokens: number }>,
  }

  const startedMs = Date.now()
  const sql = postgres(env.DATABASE_URL)
  try {
    await runTurn(
      {
        sql,
        limits: DEFAULT_LIMITS,
        agent: routeAgent({
          sql,
          transport,
          limits: DEFAULT_LIMITS,
          now: () => Date.now(),
          notifier: new LogNotifier(),
          flights: new KiwiSupplier(),
          hotels: searchKey ? new SearchApiHotels(searchKey) : new MockSupplier({ kind: 'hotel' }),
          jev: { apiKey: loadOptionalEnv(process.env, 'JEV_KEY') ?? throwMissing('JEV_KEY') },
        }),
        now: () => Date.now(),
        deadlineMs: () => startedMs + BACKGROUND_BUDGET_MS,
        reinvoke: invokeBackground(env),
        notifier: new LogNotifier(),
      },
      turnId,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }

  return new Response('ok', { status: 200 })
}
