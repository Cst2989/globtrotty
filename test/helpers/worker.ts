import type postgres from 'postgres'
import { vi } from 'vitest'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { echoAgent, type WorkerDeps } from '../../src/worker.js'

/**
 * One `WorkerDeps` for every test that drives `runTurn`, rather than a copy per
 * file. The copies had already started to drift: the second one omitted the
 * `vi.fn()` on `reinvoke`, so a test written against it could not have asserted
 * that a turn was, or was not, handed back. A shared shape means a test that
 * wants to know only has to ask.
 *
 * The second parameter is an OVERRIDES object rather than the positional
 * `Agent` it was until lesson 5.1. Every field of `WorkerDeps` is now varied the
 * same way, which is what the previous version's docstring asked for in words
 * and could not deliver in its signature: a caller that wanted a `deadlineMs`
 * had to build the deps, assign the field, and remember to hold on to the object
 * rather than call the helper inline. Lesson 5.1 needs exactly that at three
 * call sites, because a driver step is now one model call and a hand-back has to
 * be provoked between two of them.
 */
export const workerDeps = (sql: postgres.Sql, over: Partial<WorkerDeps> = {}): WorkerDeps => ({
  sql,
  limits: DEFAULT_LIMITS,
  agent: echoAgent,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: vi.fn().mockResolvedValue(undefined),
  sleep: async () => {},
  random: () => 0,
  ...over,
})
