const KEYS = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WORKER_SHARED_SECRET',
  'ANTHROPIC_API_KEY',
  'SITE_URL',
] as const

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

/**
 * A second door beside `loadEnv`, deliberately not folded into `KEYS`: this key
 * is optional, not required, and `KEYS`'s whole contract (`loadEnv` is
 * all-or-nothing) would be broken by an entry that must NOT block startup when
 * it is missing. An empty string is treated the same as absent — a blank env
 * var (a placeholder left in a `.env` file, a Netlify UI field cleared but not
 * deleted) must read as "not configured", not as a present-but-useless key.
 */
export function loadOptionalEnv(
  source: Record<string, string | undefined>, key: 'GOOGLE_SEARCH_API' | 'JEV_KEY',
): string | null {
  const value = source[key]
  return value ? value : null
}
