/**
 * The eval runner. Keyless by design, and it needs a database:
 *
 *   npm run evals
 *
 * What it grades from lesson 6.3 is three golden cases (`evals/golden-trips.json`),
 * each one a whole conversation driven end to end with nobody typing: the
 * scripted traveller (src/evals/sim-user.ts) answers from her persona's facts,
 * the real handler and the real worker do the work, and every model response
 * comes off a recording, so a reader with no key runs the same three
 * conversations the author recorded. Until this lesson it graded two worlds the
 * mock supplier produced from two seeds and a reply written into a constant,
 * which is not an eval of an agency.
 *
 * It may exit 1, on purpose, and at this tag it does. A check that reached a
 * verdict and failed is the run going red; the nulls leave the exit code alone,
 * which is the whole argument for a third value: a property nobody could reach
 * has not failed.
 *
 * The database half is the gate section. It reads course.gate_results, which is
 * where the production checks record every verdict they reach, so the card
 * carries the gates' own numbers beside the graded ones rather than a second
 * set computed here. It is asked for each case's own user id and the rows are
 * summed, so the `gate:` rows are this run's gates and nobody else's. The gate
 * rows do not decide the exit code: a gate that refused a bad proposal is the
 * system working, and reddening the run for it would teach a reader that a red
 * gate row is noise.
 *
 * `replayClient` comes from `test/`, which is the one place this runner reaches
 * into that directory. It is the branch's only keyless model client and a copy
 * under `src/` would be two clients to keep in step, so `tsconfig.json` compiles
 * both roots and the import is legal.
 *
 * IT WRITES. From lesson 6.3 this command drives three whole conversations
 * through the real handler and the real worker against a real connection with no
 * transaction, so it commits conversations, turns, messages, tool results,
 * proposals, gate results and model calls under three fresh user ids. It deletes
 * them again at the end, children first, by the ids it minted, which is
 * `withRealDb`'s pattern (test/helpers/db.ts) applied to a script that has no
 * test harness to roll it back. The gate numbers are read BEFORE the delete,
 * because they are read out of the rows this run wrote.
 */
import 'dotenv/config'
import { config } from 'dotenv'
import type postgres from 'postgres'
import { connect } from '../src/db.js'
import { fixtureFor, loadGoldenCases } from '../src/evals/cases.js'
import { gateMetrics, gateRows, type GateMetric } from '../src/evals/gateMetrics.js'
import type { Grade } from '../src/evals/grade.js'
import { runCase } from '../src/evals/runner.js'
import { makeSimulatedUser } from '../src/evals/sim-user.js'
import { renderScorecard, scorecardOf, withRows } from '../src/evals/scorecard.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { replayClient } from '../test/model/replay.js'

// The guard is scripts/demo.ts's, word for word: two scripts giving different
// advice about the same missing variable is how a reader learns to ignore both.
config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

/**
 * One run's gate counts, from the per-case counts.
 *
 * Summed over the cases rather than asked once for all of them, because
 * `gateMetrics` is scoped to ONE user id and `runCase` mints a fresh one per
 * case so that no case's spend can exhaust another's. Added by gate NAME, so a
 * row this file cannot place (`OTHER_GATES`) survives the addition instead of
 * being dropped into whichever position it happened to occupy.
 */
function sumMetrics(perCase: GateMetric[][]): GateMetric[] {
  const byGate = new Map<string, GateMetric>()
  for (const metrics of perCase) {
    for (const m of metrics) {
      const seen = byGate.get(m.gate)
      if (!seen) { byGate.set(m.gate, { ...m }); continue }
      seen.passed += m.passed
      seen.failed += m.failed
      seen.notEvaluated += m.notEvaluated
    }
  }
  return [...byGate.values()]
}

/**
 * Deletes everything this run wrote, by the ids this run minted, children first.
 *
 * The order and the reasoning are `withRealDb`'s (test/helpers/db.ts), because
 * this is the same problem: a real commit with no transaction to roll back.
 * `course.agent_events.turn_id` is `on delete set null` (migration 0017), so
 * those rows outlive the turn that wrote them and have to go before it.
 * `course.source_memory` is deliberately absent rather than forgotten: a fact
 * about a property belongs to nobody (migration 0016), so there is no user id to
 * delete it by, and nothing on this path writes one.
 *
 * A failure here is logged and swallowed. Some rows left behind are cheaper than
 * a proof command that reports a scorecard and then exits on a delete, and the
 * scorecard is already printed by the time this runs.
 */
async function deleteRunRows(sql: postgres.Sql, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  try {
    await sql`delete from course.model_calls where user_id = any(${userIds})`
    await sql`delete from course.link_clicks where user_id = any(${userIds})`
    await sql`delete from course.proposals where user_id = any(${userIds})`
    await sql`delete from course.gate_results where user_id = any(${userIds})`
    await sql`delete from course.tool_results where user_id = any(${userIds})`
    await sql`delete from course.user_memory where user_id = any(${userIds})`
    await sql`delete from course.agent_events where user_id = any(${userIds})`
    await sql`delete from course.messages where user_id = any(${userIds})`
    await sql`delete from course.turns where user_id = any(${userIds})`
    await sql`delete from course.conversations where user_id = any(${userIds})`
    await sql`delete from course.daily_usage where user_id = any(${userIds})`
  } catch (err) {
    console.error(`the eval run could not delete its own rows: ${String(err)}`)
  }
}

async function main(): Promise<void> {
  const cases = loadGoldenCases()
  const graded: { caseId: string; grades: Grade[] }[] = []
  const evalUsers: string[] = []
  const sql = connect(process.env.DATABASE_URL!, 2)
  try {
    for (const kase of cases) {
      const client = replayClient(fixtureFor(kase.id))
      try {
        const result = await runCase(
          { sql, client, limits: DEFAULT_LIMITS, simUser: makeSimulatedUser },
          kase,
        )
        // The id FIRST, and `done()` after it. A drifted fixture is exactly the
        // case a developer runs over and over, so it is the worst one to leak
        // rows on, and `done()` below is a throw: anything after it is skipped,
        // `deleteRunRows` never learns this id, and every conversation, turn,
        // message, tool result, proposal, gate result and model call this case
        // committed stays behind on every attempt.
        evalUsers.push(result.userId)
        // The other half of a replay. `done()` is what reports "N recorded calls
        // were never used", which is how a fixture that has drifted out of step
        // with the code announces itself, and the command this lesson tells a
        // reader to run has to be the one that hears it. It throws into the same
        // catch, so a drifted fixture is a case that did not complete rather
        // than a card printed over a recording nobody finished. The case is left
        // out of `graded` by that throw and stays in `casesExpected`, which is
        // the denominator doing its job.
        client.done()
        graded.push({ caseId: result.caseId, grades: result.grades })
      } catch (err) {
        // Counted in casesExpected and not in casesGraded, and named on the way
        // past. A case that threw is not a case that failed a check, and folding
        // the two together is how a suite reports 100% over the three cases that
        // still run.
        console.error(`case ${kase.id} did not complete: ${String(err)}`)
      }
    }
    const perCase: GateMetric[][] = []
    for (const userId of evalUsers) perCase.push(await gateMetrics(sql, { userId }))
    const card = withRows(scorecardOf(graded, cases.length), gateRows(sumMetrics(perCase)))
    console.log(renderScorecard(card))
    await deleteRunRows(sql, evalUsers)
  } finally {
    await sql.end({ timeout: 5 })
  }

  const checks = graded.flatMap((g) => g.grades.flatMap((grade) =>
    grade.checks.map((check) => ({ caseId: g.caseId, check }))))
  for (const { caseId, check } of checks) {
    if (check.passed === false) console.log(`  FAIL  ${caseId}  ${check.name}: ${check.detail}`)
  }
  for (const { caseId, check } of checks) {
    if (check.passed === null) console.log(`  ${caseId}  ${check.name}: ${check.detail}`)
  }
  // Red on a verdict and never on a null. A proof command that cannot go red is
  // the shape of problem this module opens on, and one that went red because
  // four properties have not been built yet would train the reader to ignore it.
  const failed = checks.filter(({ check }) => check.passed === false).length
  if (failed > 0) process.exitCode = 1
}

await main()
