/**
 * The variables this branch cannot run without. Two from lesson 2.1, plus the
 * two lesson 2.2 adds for tier 3: `WORKER_SHARED_SECRET`, read by the
 * background function and by `httpInvoke`, and `SITE_URL`, read by
 * `httpInvoke` to know where tier 3 lives. Reported all at once rather than
 * one per run, because finding out about a second missing key after fixing
 * the first is a second wasted deploy.
 */
const KEYS = ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'WORKER_SHARED_SECRET', 'SITE_URL'] as const

export type Env = Record<(typeof KEYS)[number], string>

export class EnvError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required environment variables: ${missing.join(', ')}`)
    this.name = 'EnvError'
  }
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  const missing = KEYS.filter((k) => !source[k])
  if (missing.length) throw new EnvError([...missing])
  return Object.fromEntries(KEYS.map((k) => [k, source[k]!])) as Env
}
