import { gradeOutput, gradeTrajectory, NOT_YET, type Trace } from '../src/evals/grade.js'
import type { RehydratedItem } from '../src/gates/types.js'
import { money } from '../src/money.js'
import { mockSuppliers, type MockConfig } from '../src/supplier/mock.js'
import type { HotelSearch } from '../src/supplier/types.js'

const STAY: HotelSearch = {
  kind: 'hotel', query: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26',
  adults: 2, currency: 'EUR',
}

const rehydrated = async (over: Omit<MockConfig, 'kind'> = {}): Promise<RehydratedItem[]> => {
  const items = await mockSuppliers({ hotel: over }).hotel.search(STAY)
  return items.map((item) => ({
    ref: { sourceId: item.sourceId, quantity: 1, slot: 'stay' },
    item,
    lineTotal: item.price,
  }))
}

const EXPECTED = {
  budget: money(150_000n, 'EUR'),
  currency: 'EUR',
  mustInclude: ['crib'],
  window: { earliest: '2026-09-15', latest: '2026-09-30' },
}

describe('grading the output', () => {
  it('fails a reply that never mentions the crib she asked for twice', async () => {
    const grade = gradeOutput('Three beachfront stays in Faro for your week.', await rehydrated(), EXPECTED)
    const check = grade.checks.find((c) => c.name === 'must_include')!
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('crib')
  })

  it('passes the same reply once the crib is in it', async () => {
    const grade = gradeOutput('A beachfront stay with a crib in the room.', await rehydrated(), EXPECTED)
    expect(grade.checks.find((c) => c.name === 'must_include')!.passed).toBe(true)
  })

  it('refuses a set priced in a currency she did not ask for', async () => {
    // `currency` on MockConfig is a deliberately dishonest supplier, which is
    // exactly the set lesson 4.5's currency gate was built for.
    const grade = gradeOutput('A crib is included.', await rehydrated({ currency: 'USD' }), EXPECTED)
    const check = grade.checks.find((c) => c.name === 'one_currency')!
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('USD')
  })

  it('reports the budget and the window as unreached rather than as passed', async () => {
    // The two the gates own. They carry a reason naming lesson 6.2, so a reader
    // of this tag's scorecard is told what has not been looked at.
    const grade = gradeOutput('A crib is included.', await rehydrated(), EXPECTED)
    for (const name of ['within_budget', 'inside_her_window']) {
      const check = grade.checks.find((c) => c.name === name)!
      expect(check.passed).toBeNull()
      expect(check.detail).toContain(NOT_YET.gates)
    }
  })
})

describe('grading the path', () => {
  const trace = (names: string[]): Trace => ({
    calls: names.map((name, i) => ({ name, callId: `s${i}-b0` })),
    replies: [],
  })

  it('fails a hotel lookup that took fourteen frontier turns', () => {
    const grade = gradeTrajectory(trace(Array(14).fill('search_hotels')), {
      minFrontierCalls: 1, maxFrontierCalls: 3, maxQuestionsAsked: 2,
    })
    expect(grade.checks.find((c) => c.name === 'call_count_fits_the_job')!.passed).toBe(false)
  })

  it('fails a whole trip that took one call, which is the same fault inverted', () => {
    const grade = gradeTrajectory(trace(['search_hotels']), {
      minFrontierCalls: 4, maxFrontierCalls: 10, maxQuestionsAsked: 3,
    })
    const check = grade.checks.find((c) => c.name === 'call_count_fits_the_job')!
    expect(check.passed).toBe(false)
    expect(check.detail).toContain('expected 4 to 10')
  })

  it('counts ask_user against the question budget and nothing else against it', () => {
    const grade = gradeTrajectory(
      trace(['ask_user', 'ask_user', 'ask_user', 'ask_user', 'search_flights']),
      { minFrontierCalls: 1, maxFrontierCalls: 10, maxQuestionsAsked: 3 },
    )
    expect(grade.checks.find((c) => c.name === 'questions_stayed_few')!.passed).toBe(false)
    expect(grade.checks.find((c) => c.name === 'call_count_fits_the_job')!.passed).toBe(true)
  })

  it('reports the two P3 names and lesson 6.5 has not built as unreached', () => {
    const grade = gradeTrajectory(trace(['search_flights']), {
      minFrontierCalls: 1, maxFrontierCalls: 10, maxQuestionsAsked: 3,
    })
    for (const name of ['every_number_has_a_search', 'questions_before_guesses']) {
      expect(grade.checks.find((c) => c.name === name)!.passed).toBeNull()
    }
  })
})
