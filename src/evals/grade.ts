import { compareMoney, formatMoney, type Money } from '../money.js'
import type { DateWindow } from '../gates/checks.js'
import type { GateName, RehydratedItem } from '../gates/types.js'
import type { SupplierItem } from '../supplier/types.js'
import type { GateVerdicts } from './replay.js'
import {
  announcedButNeverCalled, provenanceRate, questionsBeforeGuesses, type Trace,
} from './trajectory.js'

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

/**
 * `Trace` and `TraceCall` live in src/evals/trajectory.ts from lesson 6.5, and
 * this file imports the type rather than re-exporting it. One definition rather
 * than two, and the M5 precedent is `Desk`: two types with one name in two
 * modules is how the two come to mean different things.
 */

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
 * Why a check is null, as a constant rather than as a sentence at the call site.
 *
 * The reason NOT_EVALUATED is one (src/gates/pipeline.ts): two nulls that read
 * differently are two nulls nobody can group, and a scorecard's whole job is
 * grouping.
 *
 * One key, and it held two until this lesson. `path` said the path is graded in
 * lesson 6.5, and lesson 6.5 grades it, so the constant is gone rather than
 * kept as a sentence about a version of this file that no longer exists. What
 * is left is not a deferral at all: a case that reached no proposal has no gate
 * verdict to replay, which is a fact about the run and not about the repository.
 */
export const NOT_YET = {
  gates: 'not evaluated: this case reached no proposal, so there is no gate verdict to replay',
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
 * against a RANGE and never against a ceiling.
 *
 * `priced` is the conversation's own corpus, rehydrated by the caller out of
 * `course.tool_results`, and it is the third argument because the other two
 * cannot answer the question it answers: a number in a sentence is right or
 * invented depending on what the agency actually looked up, and only the corpus
 * knows. The checks themselves live in src/evals/trajectory.ts, beside the
 * reader that assembles the trace, so a property and the rows it is read from
 * are one file rather than two.
 *
 * A third check joins the two lesson 6.1 wrote. `announced_work_was_done` is
 * the one fault in this module that a reply cannot betray: two identical
 * sentences, one true and one invented, are told apart by their traces and by
 * nothing else.
 *
 * ## What the two counted checks count, now that the trace can tell
 *
 * Both were written at lesson 6.1 against a trace that could answer neither
 * question precisely, and lesson 6.5's `loadTrace` can, so both say which
 * quantity they grade rather than leaving a reader to assume.
 *
 * `call_count_fits_the_job` counts the calls the harness EXECUTED and not the
 * blocks the model EMITTED. The driver answers the first `tool_use` block of a
 * response and drops its siblings (src/agents/driver.ts), so an emitted count
 * would charge the desk for work nobody did: across the three shipped
 * recordings that is 59, 107 and 140 emitted against 22, 50 and 68 run. The
 * executed number is the one that spends money and supplier quota, which is what
 * a range around the size of the job is about. A desk that asks for three
 * searches at once and gets one is a fact about the PROMPT, and it belongs to
 * the lesson that shortens the path rather than to this row.
 *
 * `questions_stayed_few` counts QUESTIONS and not `ask_user` calls. One call
 * carries one to three of them (`AskUser`, src/tools/registry.ts), and the three
 * shipped recordings put 3, 32 and 61 questions behind 1, 11 and 20 calls, so
 * counting calls understated `hotel-only-02` by 2.9 times. `maxQuestionsAsked`
 * on a golden case is a ceiling on what a traveller is made to answer rather
 * than on how many times the desk opened its mouth. The detail prints both,
 * because a desk that asked nine things in three calls and one that asked nine
 * in nine are the same row and not the same behaviour.
 */
export function gradeTrajectory(
  trace: Trace, expected: TrajectoryExpectation, priced: Map<string, SupplierItem>,
): Grade {
  const frontier = trace.calls.length
  const asked = trace.calls.reduce((n, c) => n + c.questions, 0)
  const askCalls = trace.calls.filter((c) => c.name === 'ask_user').length
  const provenance = provenanceRate(trace, priced)
  const askedFirst = questionsBeforeGuesses(trace)
  const announced = announcedButNeverCalled(trace)
  return {
    checks: [
      {
        name: 'call_count_fits_the_job',
        passed: frontier >= expected.minFrontierCalls && frontier <= expected.maxFrontierCalls,
        detail: `${frontier} tool calls ran, expected ${expected.minFrontierCalls} to ${expected.maxFrontierCalls}.`,
      },
      {
        name: 'questions_stayed_few',
        passed: asked <= expected.maxQuestionsAsked,
        detail: `${asked} questions asked in ${askCalls} calls, at most ${expected.maxQuestionsAsked} expected.`,
      },
      {
        name: 'every_number_has_a_search',
        // Null when there was nothing to look at. A reply with no amounts in it
        // has not proved its provenance, it has said nothing about money, and
        // reporting that as a pass is how a denominator quietly shrinks.
        passed: provenance.denominator === 0 ? null : provenance.numerator === provenance.denominator,
        detail: `${provenance.numerator}/${provenance.denominator} quoted amounts appear in the corpus.`,
      },
      {
        name: 'questions_before_guesses',
        passed: askedFirst,
        detail: askedFirst
          ? 'No supplier search ran before the first question.'
          : 'A supplier search ran before anything was asked.',
      },
      {
        name: 'announced_work_was_done',
        passed: announced.length === 0,
        detail: announced.length === 0
          ? 'No reply claimed work with no call behind it.'
          : `${announced.length} reply or replies claimed an entry-rules check with no research_destination call.`,
      },
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
