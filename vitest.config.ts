import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
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
