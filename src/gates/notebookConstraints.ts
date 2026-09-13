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
 * The travel window the dates gate compares a proposal against, derived from the
 * two fields the notebook actually carries.
 *
 * ## Why this exists, when the previous version of this file argued against it
 *
 * That argument was that `month` plus `nights` is the gate asserting an
 * itinerary she never stated: she said the second half of September, and a
 * window running from the first would accept a departure she had already ruled
 * out, which is a pass the gate did not earn. Every word of that is still true,
 * and the conclusion drawn from it was wrong, because the alternative was never
 * a strict gate. It was `passed: null` on every proposal ever made, which is not
 * a rejection either: a proposal for March passed the dates gate, and nothing in
 * the system ever noticed.
 *
 * So the window is deliberately WIDE and the lesson calls it a stopgap. It runs
 * from the first day of the month she named to the last day of that month plus
 * her nights, which is a real constraint on the only failure that has ever
 * mattered here, a trip proposed in the wrong month, and it is not a constraint
 * on the half of the month she prefers. `checkDates` prints the window back to
 * the model on a rejection, so what the model is told matches what was checked.
 *
 * ## Why extraction is not widened instead
 *
 * The honest fix is `departureDate` and `returnDate` on the notebook, and it
 * costs more than this module has. It means changing `RequirementsSchema`
 * (src/extract.ts), which changes the extraction prompt, which changes what the
 * recorded `test/fixtures/model/extract-portugal.json` would return, and that
 * fixture cannot be re-recorded without a key that `npm test` does not have. A
 * fixture is a contract with the past. Module 6 records fresh ones for its
 * evals and is where the notebook grows dates.
 *
 * ## The year
 *
 * `month` is a name and not a date, so the year is the next occurrence of that
 * month on or after `today`. She writes to a travel agency in August about
 * September, and the September she means is the one that has not happened yet.
 *
 * ## The type
 *
 * `DateWindow` on this branch is two yyyy-mm-dd STRINGS and not two `Date`s
 * (src/gates/checks.ts, lesson 4.5), because `checkDates` compares them against
 * the first ten characters of a supplier's local timestamp, with no parsing and
 * no zone. So the arithmetic is done in UTC here and handed back as the same
 * ten characters the gate reads.
 */
export function travelWindowFrom(nb: Notebook, today: string): DateWindow | null {
  if (nb.month === null) return null
  const index = MONTHS.indexOf(nb.month.value.trim().toLowerCase())
  if (index === -1) return null
  const now = new Date(`${today}T00:00:00Z`)
  const year = index >= now.getUTCMonth() ? now.getUTCFullYear() : now.getUTCFullYear() + 1
  const earliest = new Date(Date.UTC(year, index, 1))
  // The last day of the month, then the stay on top of it, so a trip that starts
  // on the 30th and runs a week is inside the window rather than outside it by
  // six days.
  const nights = nb.nights?.value ?? 0
  const latest = new Date(Date.UTC(year, index + 1, 0 + nights))
  return { earliest: day(earliest), latest: day(latest) }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december']

/** The date half of an ISO timestamp, which is what a DateWindow holds. */
function day(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Maps the notebook into the shape the gates consume. The only mapper: two call
 * sites deriving a trip currency from a budget independently is how one of them
 * ends up defaulting.
 *
 * `today` is required and has no default, because a default is how one caller
 * silently keeps the old behaviour: every production caller passes `TODAY`
 * (src/conversation.ts), which is the one place the course's fixed date lives.
 */
export function constraintsFromNotebook(nb: Notebook, today: string): NotebookConstraints {
  const budget = nb.budget?.value ?? null
  return { budget, currency: budget?.currency ?? null, window: travelWindowFrom(nb, today) }
}
