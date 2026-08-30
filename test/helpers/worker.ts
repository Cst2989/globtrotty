import type postgres from 'postgres'
import { vi } from 'vitest'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { echoAgent, type Agent, type WorkerDeps } from '../../src/worker.js'

/**
 * One `WorkerDeps` for every test that drives `runTurn`, rather than a copy per
 * file. The copies had already started to drift: the second one omitted the
 * `vi.fn()` on `reinvoke`, so a test written against it could not have asserted
 * that a turn was, or was not, handed back. A shared shape means a test that
 * wants to know only has to ask.
 *
 * Everything a test is likely to vary is a plain, writable field: assign
 * `deadlineMs`, `heartbeatIntervalMs` or `onHeartbeat` on the returned object
 * (test/worker.test.ts does exactly this) instead of adding a parameter here
 * for each one.
 */
export const workerDeps = (sql: postgres.Sql, agent: Agent = echoAgent): WorkerDeps => ({
  sql,
  limits: DEFAULT_LIMITS,
  agent,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: vi.fn().mockResolvedValue(undefined),
  sleep: async () => {},
  random: () => 0,
})
