/**
 * The eval runner. Keyless by design and databaseless at this tag:
 *
 *   npm run evals
 *
 * What it grades today is two worlds the mock supplier produces from two seeds,
 * which is the pair lesson 6.1's snapshot test could not tell apart: every
 * offer in each is as defensible as every offer in the other, and a snapshot
 * over either one goes red on the other for no reason anybody cares about.
 * Lesson 6.3 gives it real golden cases and a real conversation to drive, and
 * from lesson 6.2 it also reads course.gate_results and needs DATABASE_URL.
 */
import { gradeOutput, gradeTrajectory, type Grade, type Trace } from '../src/evals/grade.js'
import { renderScorecard, scorecardOf } from '../src/evals/scorecard.js'
import { money } from '../src/money.js'
import type { RehydratedItem } from '../src/gates/types.js'
import { mockSuppliers } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'

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

/** The two worlds, by the seed that produces each, exactly as the test names them. */
const WORLDS = [
  { caseId: 'faro-seed-1', seed: 1, reply: 'A beachfront stay in Faro with a crib in the room.' },
  { caseId: 'faro-seed-77', seed: 77, reply: 'A beachfront stay in Faro with a crib in the room.' },
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
  console.log(renderScorecard(scorecardOf(graded, WORLDS.length)))
  for (const g of graded) {
    for (const grade of g.grades) {
      for (const check of grade.checks) {
        if (check.passed === null) console.log(`  ${g.caseId}  ${check.name}: ${check.detail}`)
      }
    }
  }
}

await main()
