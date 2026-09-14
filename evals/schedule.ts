import type { GoldenCase } from '../src/evals/cases.js'

export type ScheduleName = 'per-pr' | 'nightly' | 'shadow'

export type ScheduleEntry = {
  name: ScheduleName
  /** The cron expression, or null for the one that runs on an event rather than a clock. */
  cron: string | null
  cases: 'all' | number
  runs: number
  judge: boolean
  trajectory: boolean
  why: string
}

/**
 * Where each eval runs, as data rather than as a paragraph.
 *
 * P3's third review note is that part 2's drift detection assumes you KNOW a
 * migration is happening, which is true for one you perform and false for the
 * case the section exists to catch, where the provider moves the weights under
 * a stable alias and nobody schedules anything. Its own suggested rewrite is to
 * make this a SCHEDULE and not an event, and to alarm on the SCORE moving
 * rather than on a version string changing, which is what lesson 5.6's canary
 * could not do with one prompt at one seat. This table is that rewrite.
 *
 * It is deliberately not a release canary. A release canary compares a change
 * we made against the version before it, and module 7 lesson 5 owns that
 * distinction; everything here runs on a clock against a fixed input and knows
 * nothing about what shipped.
 *
 * Nothing reads the cron expressions. They are documentation and one
 * `netlify/functions/` scheduled function away from being wired, and README.md
 * carries that as a residual with an owner rather than this table pretending
 * otherwise.
 */
export const SCHEDULE: Record<ScheduleName, ScheduleEntry> = {
  'per-pr': {
    name: 'per-pr', cron: null, cases: 5, runs: 1, judge: false, trajectory: true,
    why: 'Minutes and cents, on every push. Five cases once each, the gates and the path, no judge: '
      + 'a judge call per pull request buys a number nobody reads and a bill everybody sees.',
  },
  nightly: {
    name: 'nightly', cron: '0 3 * * *', cases: 'all', runs: 3, judge: true, trajectory: true,
    why: 'Every case three times, so pass^k has a k, plus the judge over the night\'s proposals. '
      + 'This is the run whose SCORE is watched: a model whose weights moved under a stable alias '
      + 'shows up here as a score that fell, and nowhere else.',
  },
  shadow: {
    name: 'shadow', cron: '0 4 * * 0', cases: 'all', runs: 1, judge: true, trajectory: true,
    why: 'The standing shadow suite, weekly, against whatever configuration is being considered. '
      + 'P3 describes it as the run before a migration; it stands rather than waiting for one, '
      + 'because the migrations this repository cannot schedule are the ones it needs to catch.',
  },
}

/**
 * The cases one schedule runs, in the order `loadGoldenCases` returned them.
 *
 * `slice` and not a sample. A per-PR run that drew five cases at random would
 * report a score that moved between two pushes that changed nothing, which is
 * the one thing a per-PR number must never do.
 */
export function selectionFor(name: ScheduleName, all: GoldenCase[]): GoldenCase[] {
  const entry = SCHEDULE[name]
  return entry.cases === 'all' ? all : all.slice(0, entry.cases)
}
