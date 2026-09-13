import type { Check } from '../src/evals/grade.js'
import { rate, renderScorecard, scorecardOf, tally, withRows } from '../src/evals/scorecard.js'

const check = (name: string, passed: boolean | null): Check => ({ name, passed, detail: 'd' })

describe('the tally', () => {
  it('counts a null as neither a pass nor a fail', () => {
    const t = tally([check('a', true), check('a', false), check('a', null)])
    expect(t).toEqual({ passed: 1, failed: 1, notEvaluated: 1 })
  })
})

describe('the rate', () => {
  it('prints the fraction before the percentage, always', () => {
    expect(rate({ passed: 9, failed: 1, notEvaluated: 0 })).toBe('9/10 (90%)')
  })

  it('keeps the unreached checks out of the denominator and names them anyway', () => {
    // 9 of 10 with two unreached is not 9 of 12: a check nobody could run has
    // not failed. Hiding the two would be the silent-drop this whole module is
    // built to make impossible.
    expect(rate({ passed: 9, failed: 1, notEvaluated: 2 })).toBe('9/10 (90%, 2 not evaluated)')
  })

  it('refuses to invent a percentage over an empty denominator', () => {
    expect(rate({ passed: 0, failed: 0, notEvaluated: 4 })).toBe('0/0 (n/a, 4 not evaluated)')
  })
})

describe('the scorecard', () => {
  it('groups by check name across cases and keeps first-seen order', () => {
    const card = scorecardOf([
      { caseId: 'a', grades: [{ checks: [check('must_include', true), check('one_currency', true)] }] },
      { caseId: 'b', grades: [{ checks: [check('must_include', false), check('one_currency', true)] }] },
    ], 2)
    expect(card.rows.map((r) => r.name)).toEqual(['must_include', 'one_currency'])
    expect(card.rows[0]!.tally).toEqual({ passed: 1, failed: 1, notEvaluated: 0 })
  })

  it('says how many cases it was asked for when it graded fewer', () => {
    const card = scorecardOf([{ caseId: 'a', grades: [{ checks: [check('x', true)] }] }], 3)
    expect(renderScorecard(card)).toContain('1 of 3 cases graded, 2 lost')
  })

  it('says only what it graded when nothing was lost', () => {
    const card = scorecardOf([{ caseId: 'a', grades: [{ checks: [check('x', true)] }] }], 1)
    expect(renderScorecard(card)).toContain('1 cases graded')
  })

  it('appends database rows after the graded ones and leaves the denominator alone', () => {
    // The gate counts come from course.gate_results and are about gate RUNS,
    // not about cases, so they must not move `casesGraded`: a card that counted
    // seven gate rows as seven more graded cases would be the silently growing
    // denominator this type exists to refuse.
    const card = scorecardOf([{ caseId: 'a', grades: [{ checks: [check('x', true)] }] }], 2)
    const merged = withRows(card, [{ name: 'gate:budget', tally: { passed: 3, failed: 1, notEvaluated: 2 } }])
    expect(merged.rows.map((r) => r.name)).toEqual(['x', 'gate:budget'])
    expect(merged.casesGraded).toBe(1)
    expect(merged.casesExpected).toBe(2)
    expect(renderScorecard(merged)).toContain('gate:budget')
  })
})
