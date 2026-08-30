import type { Money } from '../money.js'
import type { Notebook } from '../notebook.js'
import type { DateWindow } from './checks.js'

/**
 * The three things the deterministic gates need from the notebook, and nothing
 * else. Kept as its own type rather than passing a whole `Notebook` into
 * `runGates` so the gates cannot quietly grow a dependency on a field nobody
 * decided they should read.
 *
 * `currency` is `string | null`, not `string`. The notebook's only currency is
 * `budget.value.currency`, and a traveller who has not named a budget has not
 * named a currency either. A default of 'EUR' would be the system inventing a
 * trip currency and then rejecting every USD search result for disagreeing with
 * it. `checkCurrency` accepts null precisely so this can be honest: with null
 * it still enforces that the items agree with EACH OTHER, which is the
 * precondition `sumMoney` actually needs.
 */
export type NotebookConstraints = {
  budget: Money | null
  window: DateWindow | null
  currency: string | null
}

/**
 * Maps the notebook into the shape the gates consume. The only mapper: two call
 * sites deriving a trip currency from a budget independently is how one of them
 * ends up defaulting.
 *
 * ## Why `window` is always null on this branch
 *
 * `checkDates` takes a CLOSED window, `{earliest, latest}`, and this branch's
 * notebook has no dates to build one from. It carries `month` (a string like
 * "September") and `nights` (a number), and neither is a calendar date. Three
 * ways to invent one were considered and all three are worse than not having
 * one:
 *
 *  - The whole of the named month. She said the second half of September, and a
 *    window running from the 1st would accept a departure she already ruled
 *    out, which is a gate that reports a pass it did not earn.
 *  - `month` plus `nights`. Combining two fields she never linked is the gate
 *    asserting an itinerary she did not state.
 *  - A sentinel `latest`. `checkDates` prints the window back to the model
 *    ("outside the 2026-09-01 to 9999-12-31 travel window"), so the model is
 *    handed a constraint that reads as a bug.
 *
 * So the dates gate records `passed: null` with `NOT_EVALUATED.noWindow`
 * (src/gates/pipeline.ts) on every proposal today, which is honest, queryable,
 * and distinguishable from a pass. Widening the notebook to carry
 * `departureDate` and `returnDate` means changing `RequirementsSchema` in
 * `src/extract.ts`, the recorded extraction fixtures and `test/extract.test.ts`
 * with it, and the spec assigns none of that to this module: it lands in module
 * 5, where the desk prompts are rewritten anyway. `checkDates` ships fully
 * tested against a window a caller supplies, so the day the notebook has one,
 * the only change here is this function.
 *
 * The cost of the gap is real and worth naming: a proposal for March passes the
 * dates gate today. The stack's guarantee is about PRICES, that no number
 * reaches her a supplier did not quote, and a wrong window cannot be un-guessed
 * by the model, which would be left re-searching against a window we made up.
 * Refuse to evaluate; never invent.
 */
export function constraintsFromNotebook(nb: Notebook): NotebookConstraints {
  const budget = nb.budget?.value ?? null
  return {
    budget,
    currency: budget?.currency ?? null,
    window: null,
  }
}
