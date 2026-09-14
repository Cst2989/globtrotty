import type { CaseResult } from './runner.js'
import type { ScorecardRow } from './scorecard.js'

/**
 * The supplier world a case runs in, derived from the case id and from nothing
 * else.
 *
 * `MockSupplier` already hashes the search string, which makes one search
 * reproducible and makes one CASE reproducible only as long as every run of it
 * searches identically. That is exactly what a conversation cannot promise: the
 * desk decides the dates it searches on, and a desk that searches a day either
 * side lands in a different world. Seeding from the case id makes the world a
 * property of the case, so two runs of one case share fares however the desk
 * phrases its searches, and two different cases are overwhelmingly unlikely to
 * share one. Overwhelmingly and not never: the fold to `% 1_000_000` below makes
 * this a birthday problem, about a 0.02% chance of one collision across P3's
 * twenty cases, and the honest claim is the probability rather than a guarantee
 * the arithmetic does not give.
 *
 * FNV-1a, the same hash src/supplier/mock.ts uses, because the two numbers are
 * mixed together inside the mock and using two different hashes here would make
 * the combination harder to reason about for no gain.
 */
export function seedFor(caseId: string): number {
  let h = 0x811c9dc5
  for (const char of caseId) {
    h ^= char.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Kept away from 1, which is MockConfig's default and `RECORDED_WORLD_SEED`
  // below, so a case running in its own world can never be confused with a case
  // running in the world a recording was made in.
  return (h % 1_000_000) + 2
}

/**
 * The world a RECORDED case replays in, which is MockConfig's default and the
 * world every recording on this branch was made in.
 *
 * A recording is a sequence of model responses and the model's own
 * `propose_trip` names the source ids IT saw when the recording was made
 * (test/fixtures/model/eval-*.json, recorded at lesson 6.3 against an unseeded
 * `mockSuppliers()`). Replay those responses in any other world and the ids in
 * them match no search the conversation made, so the provenance gate refuses
 * every proposal, correctly, and the case reaches none. Re-recording the three
 * is the bill this lesson leaves, and it costs a key and real money.
 *
 * So a case that replays runs in the world its recording was made in, and
 * `seedFor` is what a case gets the first time it is recorded in a world of its
 * own. Named here with its reason rather than written as a bare `1` at two call
 * sites, because a bare 1 is indistinguishable from nobody having thought about
 * it, which is the defect this whole lesson opened on.
 */
export const RECORDED_WORLD_SEED: number = 1

/**
 * The day the eval suite plans from, and deliberately NOT `TODAY`
 * (src/conversation.ts).
 *
 * `TODAY` is the course's fixed date for the reader's own `npm run trip`, and
 * it is going to move: it is the date a lesson shows in a transcript. Every
 * golden case here says "the second half of September" or "the whole of
 * August", so anchoring them to a constant that moves for an unrelated reason
 * would re-date every case at once, silently, and the suite would keep passing
 * while measuring a different trip. Two constants that happen to hold the same
 * string today are not one constant, and this is the difference between them.
 */
export const EVAL_TODAY = '2026-08-29'

/** The instant the gates age items against. Fixed, so freshness is not a race. */
export function evalNow(): Date {
  return new Date(`${EVAL_TODAY}T10:00:00Z`)
}

export type CaseRuns = { caseId: string; passed: boolean[] }

export type PassAtK = {
  caseId: string
  k: number
  passes: number
  passedEvery: boolean
  /**
   * Passed at least once and failed at least once. P3: a case that passes twice
   * out of three is a flaky case, which is information rather than noise, and
   * the information is that something the suite has not pinned is still moving.
   */
  flaky: boolean
}

export function passAtK(runs: CaseRuns): PassAtK {
  const passes = runs.passed.filter(Boolean).length
  const k = runs.passed.length
  return {
    caseId: runs.caseId, k, passes,
    passedEvery: k > 0 && passes === k,
    flaky: passes > 0 && passes < k,
  }
}

/** One row per case, with k as the denominator and never a bare percentage. */
export function passAtKRows(results: PassAtK[]): ScorecardRow[] {
  return results.map((r) => ({
    name: `pass^k:${r.caseId}`,
    tally: { passed: r.passes, failed: r.k - r.passes, notEvaluated: 0 },
  }))
}

/**
 * A case passed when every check that reached a verdict passed.
 *
 * The nulls are left out of both sides, exactly as `rate` leaves them out of
 * the card (src/evals/scorecard.ts): a property nobody could reach has not
 * failed, and counting it as a failure would make every case on this branch
 * flaky for a reason that has nothing to do with the model.
 */
export function casePassed(result: CaseResult): boolean {
  const checks = result.grades.flatMap((g) => g.checks)
  const decided = checks.filter((c) => c.passed !== null)
  return decided.length > 0 && decided.every((c) => c.passed === true)
}
