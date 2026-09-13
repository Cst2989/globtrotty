import { gradeOutput, gradeTrajectory, NOT_YET, overBudget, type Trace } from '../src/evals/grade.js'
import type { GateVerdicts } from '../src/evals/replay.js'
import { checkBudget, checkDates, checkTotals } from '../src/gates/checks.js'
import { NOT_EVALUATED } from '../src/gates/pipeline.js'
import type { RehydratedItem } from '../src/gates/types.js'
import { money, type Money } from '../src/money.js'
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

/** The number the seed-1 Faro week straddles: two stays under it, one over. */
const BUDGET = money(75_000n, 'EUR')

/**
 * The `verdicts` half of a `ReplayResult` (src/evals/replay.ts), built here out
 * of the SAME checks the pipeline calls and bucketed by the same rule
 * `rowsFor` uses: a violation makes the row false and carries its sentences, no
 * constraint makes it null and carries the reason, and neither makes it true
 * and carries nothing. Written from the checks rather than from literals so
 * this file cannot agree with a `detail` string src/gates/checks.ts stopped
 * producing. That the DATABASE records exactly these rows is pinned against a
 * real database in test/eval-replay.test.ts.
 */
const verdictsFor = (
  items: RehydratedItem[], budget: Money | null, window = EXPECTED.window as typeof EXPECTED.window | null,
): GateVerdicts => {
  const totals = checkTotals(items, 'EUR')
  const budgetFaults = checkBudget(items, totals, budget)
  const dateFaults = checkDates(items, window)
  const verdict = (faults: { detail: string }[], unreached: string | null) =>
    faults.length > 0
      ? { passed: false, detail: faults.map((f) => f.detail).join(' ') }
      : unreached !== null
        ? { passed: null, detail: unreached }
        : { passed: true, detail: null }
  return {
    budget: verdict(budgetFaults, budget === null ? NOT_EVALUATED.noBudget : null),
    dates: verdict(dateFaults, window === null ? NOT_EVALUATED.noWindow : null),
  }
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

  it('files the currency as unreached when it was handed no items at all', () => {
    // A proposal of nothing has nothing priced in the wrong currency and
    // nothing priced in the right one. A pass here would put a property nobody
    // examined into the numerator of `rate`, which is the one direction this
    // module exists to close off.
    const grade = gradeOutput('A crib is included.', [], EXPECTED)
    const check = grade.checks.find((c) => c.name === 'one_currency')!
    expect(check.passed).toBeNull()
    expect(check.detail).toContain('no items to price')
  })

  it('files must_include as unreached when the case requires no words', async () => {
    // The same fault in the neighbouring check. An omitted `mustInclude` is
    // what a hand-written golden case gets wrong, and lesson 6.3 brings
    // hand-written golden cases.
    const grade = gradeOutput('Anything at all.', await rehydrated(), { ...EXPECTED, mustInclude: [] })
    const check = grade.checks.find((c) => c.name === 'must_include')!
    expect(check.passed).toBeNull()
    expect(check.detail).toContain('no required words')
    // And the detail does not render as a sentence with nothing after its colon.
    expect(check.detail).not.toContain(': .')
  })

  it('reports the budget and the window as unreached when no proposal was made', async () => {
    // The two the gates own. A case that never reached a proposal has no gate
    // verdict to hand in, so both stay null with the reason printed.
    const grade = gradeOutput('A crib is included.', await rehydrated(), EXPECTED)
    for (const name of ['within_budget', 'inside_her_window']) {
      const check = grade.checks.find((c) => c.name === name)!
      expect(check.passed).toBeNull()
      expect(check.detail).toContain(NOT_YET.gates)
    }
  })

  it('turns both gate-owned checks into verdicts once a replay is handed in', async () => {
    const items = await rehydrated()
    const cheapest = items.reduce((a, b) => (a.item.price.minor < b.item.price.minor ? a : b))
    const grade = gradeOutput('A crib is included.', items, EXPECTED,
      { verdicts: verdictsFor([cheapest], BUDGET) })
    for (const name of ['within_budget', 'inside_her_window']) {
      const check = grade.checks.find((c) => c.name === name)!
      expect(check.passed).toBe(true)
      expect(check.detail).toBe('The gates approved it.')
    }
  })

  it('fails within_budget on a stay that is genuinely over her number', async () => {
    // The mock's own seed-1 Faro week runs 693, 721 and 840 EUR, so a 750 EUR
    // budget is one the dearest of the three really does break. The verdict and
    // the sentence both come out of `checkBudget`, the function production
    // calls, rather than out of a second budget rule written for the evals.
    const items = await rehydrated()
    const dearest = items.reduce((a, b) => (a.item.price.minor > b.item.price.minor ? a : b))
    const grade = gradeOutput('A crib is included.', items, EXPECTED,
      { verdicts: verdictsFor([dearest], BUDGET) })
    const budget = grade.checks.find((c) => c.name === 'within_budget')!
    expect(budget.passed).toBe(false)
    expect(budget.detail).toBe('This trip totals €840.00, over the €750.00 budget.')
    // The dates gate had nothing against the same stay, so one failed check
    // does not drag the other down with it.
    expect(grade.checks.find((c) => c.name === 'inside_her_window')!.passed).toBe(true)
  })

  it('keeps a gate that could not say as a null, and never reads it as a pass', async () => {
    // The regression this check exists for. A conversation that never named a
    // budget makes the budget gate record `passed: null`, and the gate files no
    // violation because there was nothing to compare, so a grader reading only
    // "is there a budget violation" reports a green `within_budget` over a
    // comparison nobody made. Both production drivers produce exactly this
    // state on every proposal (test/doors.test.ts), so it is the common case
    // and not a corner.
    const items = await rehydrated()
    const grade = gradeOutput('A crib is included.', items, EXPECTED,
      { verdicts: verdictsFor(items, null, null) })
    const budget = grade.checks.find((c) => c.name === 'within_budget')!
    expect(budget.passed).toBeNull()
    expect(budget.detail).toBe(NOT_EVALUATED.noBudget)
    const window = grade.checks.find((c) => c.name === 'inside_her_window')!
    expect(window.passed).toBeNull()
    expect(window.detail).toBe(NOT_EVALUATED.noWindow)
  })

  it('keeps a gate the replay recorded no row for as a null too', async () => {
    // A proposal that fails provenance short-circuits, so the gates after it
    // write no row at all. An absent gate is a third thing again, and reading
    // it as a pass would be the same fault as reading a null as one.
    const grade = gradeOutput('A crib is included.', await rehydrated(), EXPECTED, { verdicts: {} })
    for (const name of ['within_budget', 'inside_her_window']) {
      const check = grade.checks.find((c) => c.name === name)!
      expect(check.passed).toBeNull()
      expect(check.detail).toContain('recorded no')
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

  it('reports the two properties lesson 6.5 has not built as unreached', () => {
    const grade = gradeTrajectory(trace(['search_flights']), {
      minFrontierCalls: 1, maxFrontierCalls: 10, maxQuestionsAsked: 3,
    })
    for (const name of ['every_number_has_a_search', 'questions_before_guesses']) {
      expect(grade.checks.find((c) => c.name === name)!.passed).toBeNull()
    }
  })
})

describe('the budget arithmetic', () => {
  it('is true only when the total is strictly over the figure she stated', () => {
    expect(overBudget(money(150_001n, 'EUR'), money(150_000n, 'EUR'))).toBe(true)
    expect(overBudget(money(150_000n, 'EUR'), money(150_000n, 'EUR'))).toBe(false)
    expect(overBudget(money(1n, 'EUR'), money(150_000n, 'EUR'))).toBe(false)
  })

  it('refuses to answer across two currencies rather than clearing the total', () => {
    // `compareMoney` throws on a mismatch, so the two available answers are a
    // refusal and a lie. A `false` here would read as "within budget" for a
    // comparison nobody made, and the amount is chosen to make that loud: a
    // million minor units against a budget of a hundred and fifty thousand.
    expect(overBudget(money(1_000_000n, 'USD'), money(150_000n, 'EUR'))).toBeNull()
  })

  it('refuses to answer when she stated no budget', () => {
    expect(overBudget(money(150_001n, 'EUR'), null)).toBeNull()
  })
})
