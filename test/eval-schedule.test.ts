import { SCHEDULE, sectionsFor, selectionFor, type ScheduleEntry, type ScheduleName } from '../evals/schedule.js'
import { loadGoldenCases, type GoldenCase } from '../src/evals/cases.js'

/**
 * Six cases that do not exist, so the per-PR entry's `cases: 5` is a number
 * with something to cut.
 *
 * `evals/golden-trips.json` holds three, so every entry in the table selects
 * the identical three today and a case that only asserted "more than none, all
 * of them real" passes whether `cases` reads 5, 1 or 'all'. Synthetic cases are
 * what make the field discriminate. They are cast rather than parsed because
 * nothing here reads a field: `selectionFor` slices a list and the list's
 * contents are beside the point.
 */
const sixCases = Array.from({ length: 6 }, (_, i) => ({ id: `synthetic-0${i}` } as GoldenCase))

describe('where each eval runs', () => {
  it('gives pass^k a k greater than one exactly where it claims to measure variance', () => {
    expect(SCHEDULE.nightly.runs).toBeGreaterThan(1)
    expect(SCHEDULE['per-pr'].runs).toBe(1)
  })

  it('keeps the judge off the per-PR run and on the two that watch a score', () => {
    expect(SCHEDULE['per-pr'].judge).toBe(false)
    expect(SCHEDULE.nightly.judge).toBe(true)
    expect(SCHEDULE.shadow.judge).toBe(true)
  })

  it('is a schedule rather than an event, which is the whole of review note 3', () => {
    // The two that alarm on a score moving run on a clock. The per-PR one is the
    // only entry with no cron, because a push is its trigger.
    expect(SCHEDULE.nightly.cron).not.toBeNull()
    expect(SCHEDULE.shadow.cron).not.toBeNull()
    expect(SCHEDULE['per-pr'].cron).toBeNull()
  })

  it('cuts the per-PR run at its ceiling and lets the other two take everything', () => {
    expect(selectionFor('per-pr', sixCases)).toHaveLength(5)
    expect(selectionFor('nightly', sixCases)).toHaveLength(6)
    expect(selectionFor('shadow', sixCases)).toHaveLength(6)
    // In list order and never sampled: a per-PR score that moved between two
    // pushes that changed nothing is the one thing a per-PR number must not do.
    expect(selectionFor('per-pr', sixCases).map((c) => c.id))
      .toEqual(['synthetic-00', 'synthetic-01', 'synthetic-02', 'synthetic-03', 'synthetic-04'])
    // And a ceiling above the list is the whole list, which is what the per-PR
    // entry's `why` claims about this branch today.
    expect(selectionFor('per-pr', loadGoldenCases())).toHaveLength(loadGoldenCases().length)
  })

  it('turns both card sections off when an entry says to, which no shipped entry does', () => {
    // `evals/run.ts` reads its two guards from `sectionsFor`, so this is the
    // decision the runner makes rather than a restatement of the table. The off
    // paths are exercised here because nothing in the table exercises them: all
    // three entries print the trajectory rates, and only per-PR turns the judge
    // off.
    for (const name of Object.keys(SCHEDULE) as ScheduleName[]) {
      expect(SCHEDULE[name].trajectory).toBe(true)
    }
    expect(sectionsFor(SCHEDULE.nightly)).toEqual(['trajectory', 'judge'])
    expect(sectionsFor(SCHEDULE['per-pr'])).toEqual(['trajectory'])
    const quiet: ScheduleEntry = { ...SCHEDULE['per-pr'], trajectory: false }
    expect(sectionsFor(quiet)).toEqual([])
    const judgeOnly: ScheduleEntry = { ...SCHEDULE.nightly, trajectory: false }
    expect(sectionsFor(judgeOnly)).toEqual(['judge'])
  })

  it('selects cases the runner can actually run', () => {
    const all = loadGoldenCases()
    for (const name of Object.keys(SCHEDULE) as ScheduleName[]) {
      const chosen = selectionFor(name, all)
      expect(chosen.length).toBeGreaterThan(0)
      expect(chosen.every((c) => all.includes(c))).toBe(true)
    }
  })

  it('names a reason for every entry, because a schedule nobody can argue with is a schedule nobody keeps', () => {
    for (const name of Object.keys(SCHEDULE) as ScheduleName[]) {
      expect(SCHEDULE[name].name).toBe(name)
      expect(SCHEDULE[name].why.length).toBeGreaterThan(40)
    }
  })
})
