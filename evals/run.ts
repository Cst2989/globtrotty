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
 */
import 'dotenv/config'
import { config } from 'dotenv'
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

async function main(): Promise<void> {
  const cases = loadGoldenCases()
  const graded: { caseId: string; grades: Grade[] }[] = []
  const evalUsers: string[] = []
  const sql = connect(process.env.DATABASE_URL!, 2)
  try {
    for (const kase of cases) {
      try {
        const result = await runCase(
          {
            sql, client: replayClient(fixtureFor(kase.id)),
            limits: DEFAULT_LIMITS, simUser: makeSimulatedUser,
          },
          kase,
        )
        evalUsers.push(result.userId)
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
