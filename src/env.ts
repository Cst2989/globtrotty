/**
 * The variables this branch cannot run without. Two today; the Netlify tier
 * adds two more in lesson 2.2. Reported all at once rather than one per run,
 * because finding out about a second missing key after fixing the first is a
 * second wasted deploy.
 */
const KEYS = ['DATABASE_URL', 'ANTHROPIC_API_KEY'] as const

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
