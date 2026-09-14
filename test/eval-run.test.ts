import { fixtureFor, loadGoldenCases } from '../src/evals/cases.js'
import { runCase } from '../src/evals/runner.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'
import { EVAL_TODAY, evalNow, RECORDED_WORLD_SEED } from '../src/evals/variance.js'
import { EVAL_LIMITS } from '../src/limits.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { replayClient } from './model/replay.js'

/** The sentence the scripted traveller ends every refusal with. */
const SHE_REFUSED = 'that is not something i will change'

describeDb('a golden case, driven end to end with nobody typing', () => {
  for (const kase of loadGoldenCases()) {
    it(`runs ${kase.id} to its expected shape`, async () => {
      await withTestDb(async (sql) => {
        const client = replayClient(fixtureFor(kase.id))
        const result = await runCase(
          {
            sql, client, limits: EVAL_LIMITS, simUser: makeSimulatedUser,
            // The recorded world, for the reason written at that constant: the
            // responses this fixture replays name the source ids of the world
            // they were recorded in, and the provenance gate is right to refuse
            // them anywhere else.
            seed: RECORDED_WORLD_SEED, now: evalNow, today: EVAL_TODAY,
          },
          kase,
        )
        // Several turns, which is the thing one fixed message could not do.
        expect(result.replies.length).toBeGreaterThan(0)
        if (kase.expect.proposals > 0) {
          expect(result.proposalId).not.toBeNull()
        } else {
          // The case whose right answer is no. It reaches no proposal, and that
          // is a PASS: no combination of a 28-night stay and a flight in this
          // world fits 1,500 EUR (the hotel floor alone is 55 * 28), so an
          // agency that proposed one has invented it.
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

  /**
   * The refusal, fired by the desk's own prose in the recorded run.
   *
   * `test/sim-user.test.ts` proves the matcher works on strings this repository
   * wrote, which is the weaker claim and the one the first round of this lesson
   * shipped: `refuses` matched as a plain substring fired ZERO times across
   * three whole recordings while a unit test handed it the exact phrase and went
   * green. This reads what she actually sent the desk, out of course.messages,
   * so a cue list that stops matching real desk prose fails here rather than
   * quietly making the refusal case a case about mock arithmetic alone.
   */
  it('has the traveller refuse, in the run, when the desk asks her to bend', async () => {
    const kase = loadGoldenCases().find((c) => c.id === 'no-for-1500-03')!
    await withTestDb(async (sql) => {
      const client = replayClient(fixtureFor(kase.id))
      const result = await runCase(
        {
          sql, client, limits: EVAL_LIMITS, simUser: makeSimulatedUser,
          seed: RECORDED_WORLD_SEED, now: evalNow, today: EVAL_TODAY,
        },
        kase,
      )
      client.done()
      const hers = await sql<{ content: string }[]>`
        select content from course.messages
         where conversation_id = ${result.conversationId} and user_id = ${result.userId}
           and role = 'user'
         order by seq`
      const refusals = hers.filter((m) => m.content.toLowerCase().includes(SHE_REFUSED))
      expect(refusals.length).toBeGreaterThan(0)
      // And it names something the case actually declared, rather than some
      // other sentence that happens to end the same way.
      const named = kase.persona.refuses.map((r) => r.what.toLowerCase())
      expect(refusals.some((m) => named.some((what) => m.content.toLowerCase().includes(what))))
        .toBe(true)
    })
  }, 180_000)

  it('gives two pinned runs of one case the same graded result', async () => {
    await withTestDb(async (sql) => {
      // portugal-toddler-01, and it is chosen because it is the SHORTEST by every
      // measured dimension: 30 recorded exchanges and 21 tool calls against
      // hotel-only-02's 65 and 40. This case runs twice against a remote
      // Postgres inside one timeout, so the measurement is what picks it and not
      // the `maxFrontierCalls` a golden case happens to declare.
      const kase = loadGoldenCases()[0]!
      const pinned = {
        sql, limits: EVAL_LIMITS, simUser: makeSimulatedUser,
        seed: RECORDED_WORLD_SEED, now: evalNow, today: EVAL_TODAY,
      }
      const first = await runCase({ ...pinned, client: replayClient(fixtureFor(kase.id)) }, kase)
      const second = await runCase({ ...pinned, client: replayClient(fixtureFor(kase.id)) }, kase)
      // The ids differ on purpose: each run mints its own user and its own
      // conversation, so the comparison is over what was GRADED and never over
      // which row it landed in.
      expect(first.userId).not.toBe(second.userId)
      expect(second.grades).toEqual(first.grades)
      expect(second.trace.calls.map((c) => c.name)).toEqual(first.trace.calls.map((c) => c.name))
    })
  }, 180_000)
})
