import type { Check, Grade } from './grade.js'

export type Tally = { passed: number; failed: number; notEvaluated: number }
export type ScorecardRow = { name: string; tally: Tally }

/**
 * `casesExpected` and `casesGraded` are two numbers and not one, and the gap
 * between them is the whole reason this type exists.
 *
 * The rule this module holds itself to is that every pass rate carries its
 * denominator, because "92% pass" means nothing if traces dropped silently. A
 * run that was asked for twenty cases and graded eighteen has a real
 * denominator of twenty, and a scorecard that reported eighteen would be
 * reporting a number that improves every time something breaks badly enough to
 * lose a case.
 */
export type Scorecard = { rows: ScorecardRow[]; casesExpected: number; casesGraded: number }

export function tally(checks: Check[]): Tally {
  return {
    passed: checks.filter((c) => c.passed === true).length,
    failed: checks.filter((c) => c.passed === false).length,
    notEvaluated: checks.filter((c) => c.passed === null).length,
  }
}

/**
 * A rate, as a fraction and then a percentage, never as a percentage alone.
 *
 * The denominator is the number of checks that reached a VERDICT, and the
 * not-evaluated count is printed beside it rather than folded into either side,
 * so a row that could not be looked at reads differently from a row that was
 * looked at and passed.
 */
export function rate(t: Tally): string {
  const decided = t.passed + t.failed
  const pct = decided === 0 ? 'n/a' : `${Math.round((t.passed / decided) * 100)}%`
  const unreached = t.notEvaluated === 0 ? '' : `, ${t.notEvaluated} not evaluated`
  return `${t.passed}/${decided} (${pct}${unreached})`
}

/** Every check of every case, grouped by check name, in first-seen order. */
export function scorecardOf(
  graded: { caseId: string; grades: Grade[] }[], casesExpected: number,
): Scorecard {
  const byName = new Map<string, Check[]>()
  for (const g of graded) {
    for (const grade of g.grades) {
      for (const check of grade.checks) {
        const bucket = byName.get(check.name) ?? []
        bucket.push(check)
        byName.set(check.name, bucket)
      }
    }
  }
  return {
    rows: [...byName].map(([name, checks]) => ({ name, tally: tally(checks) })),
    casesExpected,
    casesGraded: graded.length,
  }
}

/**
 * Database-derived rows, appended after the graded ones, in the order given.
 *
 * A second card printed underneath the first would be two denominators a reader
 * has to reconcile, and the gate counts are about the SAME run: they come from
 * the rows the cases just wrote. Appended rather than merged by name, because
 * `gate:` rows and check rows are different kinds of thing and a collision
 * between them would be a name nobody chose.
 */
export function withRows(card: Scorecard, rows: ScorecardRow[]): Scorecard {
  return { ...card, rows: [...card.rows, ...rows] }
}

export function renderScorecard(card: Scorecard): string {
  const width = Math.max(20, ...card.rows.map((r) => r.name.length))
  const lines = card.rows.map((r) => `  ${r.name.padEnd(width)}  ${rate(r.tally)}`)
  const lost = card.casesExpected - card.casesGraded
  const denominator = lost === 0
    ? `${card.casesGraded} cases graded`
    : `${card.casesGraded} of ${card.casesExpected} cases graded, ${lost} lost`
  return [`scorecard (${denominator})`, ...lines].join('\n')
}
