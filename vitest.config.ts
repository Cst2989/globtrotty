import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
    /**
     * Twenty seconds, against vitest's default five.
     *
     * Most of this suite is pure and finishes in milliseconds. The DB-backed
     * cases are not: one of them drives three whole worker invocations against a
     * REMOTE database, and lesson 5.3 put a classification call, a reservation,
     * a reconciliation, a `model_calls` row and a desk write in front of step 0
     * of every one of them. Those cases went from just inside the default to
     * just outside it, and each time they did, a green suite turned red for a
     * reason that had nothing to do with the code under test.
     *
     * Set here rather than case by case. Two cases used to carry their own
     * `20_000` argument, which is the suite conceding the default is wrong for
     * it one case at a time, in a way the next DB-backed case somebody writes
     * does not inherit. Twenty seconds is still an order of magnitude under any
     * hang worth catching, and the live canary, which really does need minutes,
     * passes its own 120s explicitly and is unaffected.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /**
     * This pins the NODE process's zone, and deliberately not to UTC, so any
     * date arithmetic a test does in JavaScript is done somewhere that is not
     * UTC and a `new Date().toISOString().slice(0, 10)` creeping into the ledger
     * shows up as a wrong day rather than a coincidence.
     *
     * It does NOT reach Postgres. `postgres` sends no TimeZone startup
     * parameter, so the database session keeps the server's zone whatever this
     * says. The guard on `current_date` is the UTC-day test in
     * test/spend.test.ts, which sets the session zone transaction-locally.
     */
    env: { TZ: 'America/Los_Angeles' },
  },
})
