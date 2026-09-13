/**
 * The eval runner. Keyless by design, and from lesson 6.2 it needs a database:
 *
 *   npm run evals
 *
 * What it grades today is two worlds the mock supplier produces from two seeds,
 * which is the pair lesson 6.1's snapshot test could not tell apart: every
 * offer in each is as defensible as every offer in the other, and a snapshot
 * over either one goes red on the other for no reason anybody cares about.
 * Lesson 6.3 gives it real golden cases and a real conversation to drive, and
 * from lesson 6.2 it also reads course.gate_results and needs DATABASE_URL.
 *
 * It exits 1 at this tag, on purpose. The second world's reply never mentions
 * the crib she asked for twice (src/her.ts), so `must_include` is a real red
 * verdict and the first card this course prints is not a wall of green. The
 * four nulls per case leave the exit code alone, which is the whole argument
 * for a third value: a property nobody could reach has not failed.
 *
 * The database half is the gate section. It reads course.gate_results, which is
 * where the production checks record every verdict they reach, so the card
 * carries the gates' own numbers beside the graded ones rather than a second
 * set computed here. At this tag that section prints zeroes, because nothing
 * has run a gate under this run's user id yet, and a section printed empty is
 * the honest version of a section left out: the reader can see what is missing.
 * The gate rows do not decide the exit code: a gate that refused a bad proposal
 * is the system working, and reddening the run for it would teach a reader that
 * a red gate row is noise.
 */
import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import { config } from 'dotenv'
import { connect } from '../src/db.js'
import { gateMetrics, gateRows, type GateMetric } from '../src/evals/gateMetrics.js'
import { gradeOutput, gradeTrajectory, type Grade, type Trace } from '../src/evals/grade.js'
import { renderScorecard, scorecardOf, withRows } from '../src/evals/scorecard.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'

// The guard is scripts/demo.ts's, word for word: two scripts giving different
// advice about the same missing variable is how a reader learns to ignore both.
config({ path: '.env.local', override: false })
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  process.exit(1)
}

const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

const EXPECTED = {
  budget: money(150_000n, 'EUR'),
  currency: 'EUR',
  mustInclude: ['crib'],
  window: { earliest: '2026-09-15', latest: '2026-09-30' },
}

/**
 * The two worlds, by the seed that produces each, and one reply per world.
 *
 * The replies differ, and they have to. `gradeOutput`'s `must_include` reads
 * nothing but the reply, so two identical strings would put ONE evaluation in
 * the card twice and print `2/2 (100%)` over it. The second reply is the answer
 * she actually gets when the agency forgets half the request: three good stays,
 * and not a word about the cot.
 */
const WORLDS = [
  { caseId: 'faro-seed-1', seed: 1, reply: 'A beachfront stay in Faro with a crib in the room.' },
  { caseId: 'faro-seed-77', seed: 77, reply: 'Three beachfront stays in Faro, sea view, for your week.' },
]

async function main(): Promise<void> {
  const graded: { caseId: string; grades: Grade[] }[] = []
  for (const world of WORLDS) {
    const items = await mockSuppliers({ hotel: { seed: world.seed } }).hotel.search(STAY)
    const rehydrated: RehydratedItem[] = items.map((item) => ({
      ref: { sourceId: item.sourceId, quantity: 1, slot: 'stay' }, item, lineTotal: item.price,
    }))
    // One search and one reply, so the trace is one call. Lesson 6.3 replaces
    // this with what the driver actually did.
    const trace: Trace = { calls: [{ name: 'search_hotels', callId: 's0-b0' }], replies: [world.reply] }
    graded.push({
      caseId: world.caseId,
      grades: [
        gradeOutput(world.reply, rehydrated, EXPECTED),
        gradeTrajectory(trace, { minFrontierCalls: 1, maxFrontierCalls: 6, maxQuestionsAsked: 3 }),
      ],
    })
  }
  // A fresh id per run, so the gate counts are this run's and not the sum of
  // every run since the database was created. Lesson 6.4 gives the reason in
  // full, when an eval run starts costing money and meets the per-user cap.
  const evalUser = randomUUID()
  const sql = connect(process.env.DATABASE_URL!, 2)
  let metrics: GateMetric[]
  try {
    metrics = await gateMetrics(sql, { userId: evalUser })
  } finally {
    await sql.end({ timeout: 5 })
  }
  console.log(renderScorecard(withRows(scorecardOf(graded, WORLDS.length), gateRows(metrics))))
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
