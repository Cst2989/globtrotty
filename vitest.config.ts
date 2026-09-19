import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Plan 4a, Task 7. Mirrors tsconfig.json's `paths` (`"@/*": ["./*"]`) —
  // Next's own build reads that straight out of tsconfig, but Vitest
  // resolves modules through Vite, which knows nothing about it without
  // this. Needed once web/app code under test (routes, components) started
  // importing other web/app modules with the `@/` alias instead of a
  // relative path.
  resolve: {
    alias: { '@': REPO_ROOT },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // CI's Postgres is a fresh local container; the default 5000ms timeout
    // has been tight enough to cause intermittent timeouts against the
    // remote Supabase project in full-suite runs. Raised for all tests
    // (DB tests are the ones this protects) rather than per-file.
    testTimeout: 30000,
    /**
     * Pinned, and deliberately NOT UTC.
     *
     * Kiwi returns naive local ISO timestamps with no offset
     * ("2026-09-12T16:40:00"). The rule across this codebase is that those are
     * strings and are never parsed into a `Date`, because applying the
     * server's zone to a zoneless string silently shifts the day. Under
     * `TZ=UTC` — the CI default — that shift is zero, so a `new Date(...)`
     * implementation of the dates gate passes every one of its tests and the
     * guard proves nothing.
     *
     * America/Los_Angeles has a negative offset, so a naive parse of
     * "2026-09-20T23:59:00" lands on 2026-09-21 in UTC and the date tests
     * fail. The pin is what makes those tests discriminate.
     */
    env: { TZ: 'America/Los_Angeles' },
  },
})
