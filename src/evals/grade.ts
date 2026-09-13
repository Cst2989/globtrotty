import { compareMoney, formatMoney, type Money } from '../money.js'
import type { DateWindow } from '../gates/checks.js'
import type { RehydratedItem } from '../gates/types.js'

/**
 * One graded property, with the evidence that decided it.
 *
 * `passed` has three values and not two, deliberately copying
 * course.gate_results (migration 0012): TRUE is the property held, FALSE is the
 * property was tested and did not hold, and NULL is nobody could reach a
 * verdict. A grader that collapsed null into false would report a suite that
 * could not look at something as a suite that looked and found it broken, and
 * every rate computed from it would be wrong in the direction that makes the
 * agency look worse. Collapsing it into true is the same mistake pointed the
 * other way, and it is the one that ships.
 */
export type Check = { name: string; passed: boolean | null; detail: string }

export type Grade = { checks: Check[] }

/** One tool call the agency made, named and identified. */
export type TraceCall = { name: string; callId: string }

/**
 * What one run of one case left behind, as much of it as lesson 6.1 can see.
 * Lesson 6.5 moves this type into src/evals/trajectory.ts and gives it the turn
 * id, the source ids and the amounts a reply quoted, because those are what the
 * three trajectory checks read and none of them exists here yet.
 */
export type Trace = { calls: TraceCall[]; replies: string[] }

export type OutputExpectation = {
  budget: Money | null
  currency: string
  mustInclude: string[]
  window: DateWindow | null
}

export type TrajectoryExpectation = {
  minFrontierCalls: number
  maxFrontierCalls: number
  maxQuestionsAsked: number
}

/**
 * Why a check is null at this tag, and which lesson makes it a verdict.
 *
 * Written as constants rather than as sentences at the call sites for the same
 * reason NOT_EVALUATED is (src/gates/pipeline.ts): two nulls that read
 * differently are two nulls nobody can group, and a scorecard's whole job is
 * grouping. Each string names the lesson that removes it, so a reader who runs
 * `npm run evals` at this tag is told what is missing rather than left to
 * notice.
 */
export const NOT_YET = {
  gates: 'not evaluated: the gates are reused offline in lesson 6.2',
  path: 'not evaluated: the path is graded in lesson 6.5',
} as const

/**
 * The first question: is what she was offered acceptable.
 *
 * Two of the four checks are answerable with nothing but the items and her own
 * words, so they are answered here. The other two need the gates, which run
 * against the provenance corpus and against a notebook this function is not
 * given, and lesson 6.2 is where they get their verdict. They are recorded as
 * nulls with a reason rather than left out of the list, because a check that is
 * absent from a scorecard cannot be counted and a denominator that silently
 * shrinks is the failure P3's last section is about.
 */
export function gradeOutput(
  reply: string, items: RehydratedItem[], expected: OutputExpectation,
): Grade {
  const lower = reply.toLowerCase()
  const missing = expected.mustInclude.filter((w) => !lower.includes(w.toLowerCase()))
  const currencies = [...new Set(items.map((i) => i.item.price.currency))]

  return {
    checks: [
      {
        name: 'must_include',
        passed: missing.length === 0,
        detail: missing.length === 0
          ? `Every required word appeared: ${expected.mustInclude.join(', ')}.`
          : `Missing from the reply: ${missing.join(', ')}.`,
      },
      {
        name: 'one_currency',
        // Checked here rather than deferred to the gates, because it needs no
        // corpus and no notebook: a proposal that mixes currencies is wrong
        // whatever her budget is, and src/money.ts refuses to add them.
        passed: currencies.length <= 1 && (currencies[0] ?? expected.currency) === expected.currency,
        detail: currencies.length === 0
          ? 'No items to price.'
          : `Items priced in ${currencies.join(', ')}; she asked in ${expected.currency}.`,
      },
      {
        name: 'within_budget',
        passed: null,
        detail: expected.budget
          ? `${NOT_YET.gates} (budget ${formatMoney(expected.budget)})`
          : `${NOT_YET.gates} (no budget stated)`,
      },
      {
        name: 'inside_her_window',
        passed: null,
        detail: expected.window
          ? `${NOT_YET.gates} (${expected.window.earliest} to ${expected.window.latest})`
          : `${NOT_YET.gates} (no travel window stated)`,
      },
    ],
  }
}

/**
 * The second question: did the agency work correctly to get there.
 *
 * A hotel lookup that took fourteen frontier turns and a whole trip that took
 * four are both wrong, in opposite directions, so the call count is checked
 * against a RANGE and never against a ceiling. The other two checks P3 names,
 * every quoted number having a search behind it and questions arriving before
 * guesses, need the transcript and the corpus, and lesson 6.5 is where they get
 * read.
 */
export function gradeTrajectory(trace: Trace, expected: TrajectoryExpectation): Grade {
  const frontier = trace.calls.length
  const asked = trace.calls.filter((c) => c.name === 'ask_user').length
  return {
    checks: [
      {
        name: 'call_count_fits_the_job',
        passed: frontier >= expected.minFrontierCalls && frontier <= expected.maxFrontierCalls,
        detail: `${frontier} tool calls, expected ${expected.minFrontierCalls} to ${expected.maxFrontierCalls}.`,
      },
      {
        name: 'questions_stayed_few',
        passed: asked <= expected.maxQuestionsAsked,
        detail: `${asked} questions asked, at most ${expected.maxQuestionsAsked} expected.`,
      },
      { name: 'every_number_has_a_search', passed: null, detail: NOT_YET.path },
      { name: 'questions_before_guesses', passed: null, detail: NOT_YET.path },
    ],
  }
}

/** Kept off the public surface until something needs it; here so `compareMoney` has a caller. */
export function overBudget(total: Money, budget: Money | null): boolean {
  if (!budget || total.currency !== budget.currency) return false
  return compareMoney(total, budget) > 0
}
