import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
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
