export type InvokeEnv = {
  SITE_URL: string
  WORKER_SHARED_SECRET: string
}

/**
 * Reads exactly the two env vars `src/invoke.ts`'s `invokeBackground` needs,
 * directly off `process.env` — never `src/env.ts`'s `loadEnv`, which
 * requires the full harness env (including the service-role key the Next
 * app never touches — see `src/db/owner.ts`'s header comment for the same
 * reasoning applied to the owner Postgres connection). Throws when either is
 * unset so a misconfigured deploy fails loudly the first time a message is
 * submitted, rather than silently POSTing to `undefined/.netlify/…`.
 */
export function readInvokeEnv(): InvokeEnv {
  const SITE_URL = process.env.SITE_URL
  const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET
  if (!SITE_URL) {
    throw new Error('SITE_URL is required to invoke the background worker')
  }
  if (!WORKER_SHARED_SECRET) {
    throw new Error('WORKER_SHARED_SECRET is required to invoke the background worker')
  }
  return { SITE_URL, WORKER_SHARED_SECRET }
}
