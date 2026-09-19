import postgres from 'postgres'

/**
 * The Next.js app's one and only Postgres client factory (fix round 1, plan
 * 4a Task 6 review, Important). `app/` and `web/` route handlers import
 * `ownerSql()` for server-side writes, never `src/env.ts`'s `loadEnv` — that
 * function requires all seven harness keys, including
 * `SUPABASE_SERVICE_ROLE_KEY`, and Next bundles whatever a Route Handler
 * imports into its own function; pulling in `loadEnv` would drag the
 * service-role key requirement into the Next runtime's environment for no
 * reason (the app never uses it — browser reads go through RLS, server
 * writes go through this direct `DATABASE_URL` connection). This module
 * reads `DATABASE_URL` and nothing else.
 *
 * The client is cached on `globalThis` rather than a plain module-level
 * variable so it survives Next's dev-mode HMR: a module-level `const`
 * would be re-initialised (and its connection silently orphaned) on every
 * edit-triggered reload, leaking a connection each time. `globalThis` is not
 * reset by HMR, so the same client is reused across reloads, matching the
 * well-known Prisma-client-singleton pattern for the same reason.
 */
const GLOBAL_KEY = '__globetrotty_owner_sql__'

type GlobalWithOwnerSql = typeof globalThis & { [GLOBAL_KEY]?: postgres.Sql }

export function ownerSql(): postgres.Sql {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required to create the owner Postgres client')
  }

  const withCache = globalThis as GlobalWithOwnerSql
  if (!withCache[GLOBAL_KEY]) {
    // `max: 1`: a Next Route Handler / Netlify function invocation is a
    // single request, not a long-lived server process fanning out queries
    // concurrently the way the background worker does.
    withCache[GLOBAL_KEY] = postgres(url, { max: 1 })
  }
  return withCache[GLOBAL_KEY]
}
