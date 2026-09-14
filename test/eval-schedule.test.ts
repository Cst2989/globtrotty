import { SCHEDULE, selectionFor, type ScheduleName } from '../evals/schedule.js'
import { loadGoldenCases } from '../src/evals/cases.js'

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
