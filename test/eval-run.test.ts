import { fixtureFor, loadGoldenCases } from '../src/evals/cases.js'
import { runCase } from '../src/evals/runner.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { replayClient } from './model/replay.js'

describeDb('a golden case, driven end to end with nobody typing', () => {
  for (const kase of loadGoldenCases()) {
    it(`runs ${kase.id} to its expected shape`, async () => {
      await withTestDb(async (sql) => {
        const client = replayClient(fixtureFor(kase.id))
        const result = await runCase(
          { sql, client, limits: DEFAULT_LIMITS, simUser: makeSimulatedUser },
          kase,
        )
        // Several turns, which is the thing one fixed message could not do.
        expect(result.replies.length).toBeGreaterThan(0)
        if (kase.expect.proposals > 0) {
          expect(result.proposalId).not.toBeNull()
        } else {
          // The case whose right answer is no. It reaches no proposal, and that
          // is a PASS: an agency that proposes a month on the Algarve for 1,500
          // euros has invented it.
          expect(result.proposalId).toBeNull()
        }
        const counts = result.grades.flatMap((g) => g.checks)
        expect(counts.some((c) => c.passed === true)).toBe(true)
        client.done()
      })
    // Three minutes, against the suite's twenty seconds
    // (vitest.config.ts). Nothing here waits on a model: every response is
    // replayed off disk. What takes the time is the DATABASE, one round trip at
    // a time, across every turn of a whole conversation, the corpus each search
    // writes, the gates each proposal runs and the replay of those gates
    // afterwards. A case that parks for want of wall clock is a case measuring
    // the network to Postgres, which is the one thing an eval must not do.
    }, 180_000)
  }
})
