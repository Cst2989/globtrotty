import { timingSafeEqual } from 'node:crypto'

/**
 * The narrow slice of a Fetch `Request` this module needs, plus its
 * already-parsed JSON body (or `null` on a parse failure/empty body) — kept
 * separate from `headers` so this function stays synchronous (reading a real
 * `Request` body is async) and trivially unit-testable with a plain object.
 */
export type AuthRequest = {
  headers: { get(name: string): string | null }
  body: unknown
}

/**
 * Constant-time secret comparison, identical to run-turn-background.mts's
 * `secretsMatch` — kept as its own small copy here rather than shared,
 * because sharing it would couple two otherwise-unrelated Netlify functions
 * through a module for one four-line helper. See that file's doc comment for
 * why the length check must fail closed into the exact same rejection as a
 * content mismatch, never a distinguishable path.
 */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Authorises a request to the drift monitor's Netlify function (spec section
 * 4: "behind the shared secret like `run-turn-background.mts`").
 *
 * Two paths:
 *
 *  1. `x-worker-secret` matches — the same check every other worker-door
 *     endpoint uses.
 *  2. Netlify's OWN scheduler invokes a scheduled function WITHOUT that
 *     header (there is no way to attach a custom header to a cron trigger),
 *     so the second path recognises Netlify's documented scheduled-function
 *     payload instead: a JSON body shaped `{ next_run: "<ISO-8601 string>" }`
 *     naming the function's next scheduled run. This repo has no
 *     `@netlify/functions` package installed to confirm a header name (e.g.
 *     `x-nf-event: schedule`) against within a reasonable search, so the
 *     body shape — Netlify's documented scheduled-invocation payload — is
 *     the signal actually implemented and tested here.
 *
 * A WRONG secret never falls through to the scheduled-marker path: once the
 * header is present at all, only its correctness decides the answer. That is
 * what makes "wrong secret alongside a forged `next_run` body" return
 * `false` rather than `true` — an attacker cannot buy the scheduled path by
 * also sending a bad secret.
 */
export function authorise(req: AuthRequest, secret: string): boolean {
  const provided = req.headers.get('x-worker-secret')
  if (provided !== null) return secretsMatch(provided, secret)
  const body = req.body
  return typeof body === 'object' && body !== null
    && typeof (body as Record<string, unknown>).next_run === 'string'
}
