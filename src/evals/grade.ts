import { compareMoney, formatMoney, type Money } from '../money.js'
import type { DateWindow } from '../gates/checks.js'
import type { GateName, RehydratedItem } from '../gates/types.js'
import type { GateVerdicts } from './replay.js'

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
 * two deferred trajectory checks below read, and none of those three fields is
 * on this type yet.
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
  gates: 'not evaluated: this case reached no proposal, so there is no gate verdict to replay',
  path: 'not evaluated: the path is graded in lesson 6.5',
} as const

/**
 * The first question: is what she was offered acceptable.
 *
 * Two of the four checks are answerable with nothing but the items and her own
 * words, so they are answered here. The other two need the gates, which run
 * against the provenance corpus and against a notebook this function is not
 * given. They are recorded as nulls with a reason rather than left out of the
 * list, because a check that is absent from a scorecard cannot be counted, and
 * a denominator that silently shrinks is the failure `casesExpected` and
 * `casesGraded` exist to make visible (src/evals/scorecard.ts).
 *
 * `replayed` is optional because a case that never reached a proposal has no
 * gate verdict to report, and there is nothing for `replayGates`
 * (src/evals/replay.ts) to run against. When it is absent the two gate-owned
 * checks stay null with their reason.
 *
 * What is read from it is `verdicts` and never the outcome, and the difference
 * is the whole point. `GateOutcome` carries `ok` and a violation list, so
 * "there is no budget violation" covers a gate that ran and was satisfied AND a
 * gate that had no budget to check and recorded `passed: null`. Both production
 * drivers hand `proposalRunner` exactly that notebook today
 * (test/doors.test.ts), so inferring a pass from an absent violation would
 * score a green `within_budget` on every conversation that never named a
 * figure. `verdicts` is the three-valued row `course.gate_results` recorded, so
 * the check reports the gate's own verdict and its own sentence, which is the
 * identity this lesson is built on rather than a second reading of it.
 */
export function gradeOutput(
  reply: string, items: RehydratedItem[], expected: OutputExpectation,
  replayed?: { verdicts: GateVerdicts },
): Grade {
  const lower = reply.toLowerCase()
  const missing = expected.mustInclude.filter((w) => !lower.includes(w.toLowerCase()))
  const currencies = [...new Set(items.map((i) => i.item.price.currency))]

  /**
   * One gate-owned check, from the row that gate wrote.
   *
   * Three ways to reach null and each says something different: no replay was
   * handed in, the replay recorded no row for this gate (provenance
   * short-circuits and the gates after it never run), or the gate ran and could
   * not reach a verdict, in which case the reason is the gate's own.
   */
  const fromGate = (name: string, gate: GateName, unreached: string): Check => {
    if (replayed === undefined) return { name, passed: null, detail: unreached }
    const verdict = replayed.verdicts[gate]
    if (verdict === undefined) {
      return {
        name,
        passed: null,
        detail: `not evaluated: the replay recorded no ${gate} verdict for this proposal.`,
      }
    }
    // A passing row carries no detail, because a gate that had nothing to say
    // says nothing (rowsFor, src/gates/pipeline.ts).
    return { name, passed: verdict.passed, detail: verdict.detail ?? 'The gates approved it.' }
  }

  return {
    checks: [
      {
        name: 'must_include',
        // A case that required nothing has had nothing checked for it. `true`
        // there would put a property nobody examined into rate()'s numerator
        // and render `Every required word appeared: .` underneath it, so the
        // empty list is a null. No lesson reaches it, which is why it carries
        // its own sentence rather than one of NOT_YET's: what is missing is a
        // field on the case, not a piece of this repository.
        passed: expected.mustInclude.length === 0 ? null : missing.length === 0,
        detail: expected.mustInclude.length === 0
          ? 'not evaluated: this case names no required words.'
          : missing.length === 0
            ? `Every required word appeared: ${expected.mustInclude.join(', ')}.`
            : `Missing from the reply: ${missing.join(', ')}.`,
      },
      {
        name: 'one_currency',
        // Checked here rather than deferred to the gates, because it needs no
        // corpus and no notebook: a proposal that mixes currencies is wrong
        // whatever her budget is, and src/money.ts refuses to add them.
        //
        // Zero items is null and not true. A set with no prices in it has
        // nothing in the wrong currency and nothing in the right one, so there
        // is no verdict to reach, and an agency that proposed nothing at all
        // would otherwise score a green row in rate()'s numerator: a property
        // nobody could look at, reading exactly like one that was looked at and
        // held.
        passed: currencies.length === 0
          ? null
          : currencies.length === 1 && currencies[0] === expected.currency,
        detail: currencies.length === 0
          ? 'not evaluated: no items to price.'
          : `Items priced in ${currencies.join(', ')}, but she asked in ${expected.currency}.`,
      },
      fromGate('within_budget', 'budget', expected.budget
        ? `${NOT_YET.gates} (budget ${formatMoney(expected.budget)})`
        : `${NOT_YET.gates} (no budget stated)`),
      fromGate('inside_her_window', 'dates', expected.window
        ? `${NOT_YET.gates} (${expected.window.earliest} to ${expected.window.latest})`
        : `${NOT_YET.gates} (no travel window stated)`),
    ],
  }
}

/**
 * The second question: did the agency work correctly to get there.
 *
 * A hotel lookup that took fourteen frontier turns and a whole trip that took
 * four are both wrong, in opposite directions, so the call count is checked
 * against a RANGE and never against a ceiling. The other two properties this
 * module owes, every quoted number having a search behind it and questions
 * arriving before guesses, need the transcript and the corpus, and lesson 6.5
 * is where they get read.
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

/**
 * Is `total` strictly over `budget`, with "nobody could say" as a third answer.
 *
 * The three values are `Check.passed`'s, for the reason `Check.passed` has
 * them. A budget in one currency and a total in another cannot be compared at
 * all, because `compareMoney` throws on a mismatch (src/money.ts), so the only
 * options are a refusal and a guess. Answering `false` would be the guess: it
 * reads as "within budget" for a comparison nobody made, and it is the fail-open
 * collapse this file's `Check` doc argues against. `checkCurrency` takes the
 * same view one layer down and reports a mixed set as a violation rather than
 * pricing it (src/gates/checks.ts). A missing budget is null for the same
 * reason: with no figure stated, nothing was exceeded and nothing was cleared.
 *
 * Nothing in this repository calls it, and test/grade.test.ts is its only
 * exercise. Lesson 6.2 did not become the caller: `within_budget` reads the
 * verdict the budget gate recorded, through `replayGates`
 * (src/evals/replay.ts), rather than re-deciding the comparison here, because
 * two budget rules is how the eval and the gate come to disagree. This stays as
 * the honest three-valued comparison a later caller can reach for.
 */
export function overBudget(total: Money, budget: Money | null): boolean | null {
  if (!budget || total.currency !== budget.currency) return null
  return compareMoney(total, budget) > 0
}
