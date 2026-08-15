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
