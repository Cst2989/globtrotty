import type { Money } from '../money.js'
import type { Notebook } from '../notebook.js'
import type { DateWindow } from './checks.js'

/**
 * The three things the deterministic gates need from the notebook, and nothing
 * else. Kept as its own type rather than passing a whole `Notebook` into
 * `runGates` so the gates cannot quietly grow a dependency on a field nobody
 * decided they should read.
 *
 * `currency` is `string | null`, NOT `string`. The brief typed it `string`, but
 * there is no non-null value to give it: the notebook's only currency is
 * `budget.value.currency`, and a traveller who has not named a budget has not
 * named a currency either. A default of 'EUR' would be the system inventing a
 * trip currency and then rejecting every USD search result for disagreeing with
 * it. `checkCurrency` accepts `null` precisely so this can be honest — with
 * `null` it still enforces that the items agree with EACH OTHER, which is the
 * precondition `sumMoney` actually needs.
 */
export type NotebookConstraints = {
  budget: Money | null
  window: DateWindow | null
  currency: string | null
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Maps the notebook into the shape the gates consume. The only mapper: two
 * call sites deriving a trip currency from a budget independently is how one of
 * them ends up defaulting.
 *
 * ## The missing return date
 *
 * `checkDates` takes a CLOSED window — `{earliest, latest}` — and there is no
 * way to express "on or after the 12th, no upper bound" in it. So when only one
 * of the two dates is known this returns `window: null` and the dates gate does
 * not run, rather than inventing the other end.
 *
 * The alternatives were considered and rejected:
 *
 *  - `latest = departure` (a single-day window). A return flight is ONE
 *    `SupplierItem` carrying both legs, and `checkDates` windows the inbound
 *    leg's departure too — so this would reject every round trip the moment
 *    the notebook happened to be missing a return date, and tell the model to
 *    re-search dates that were never wrong.
 *  - `latest = departure + nights`. `nights` is a separate, independently-set
 *    field; combining two fields the traveller never linked is the gate
 *    asserting an itinerary the traveller did not state.
 *  - A sentinel `latest = '9999-12-31'`. It enforces the real lower bound, but
 *    `checkDates` prints the window back to the model ("outside the 2026-09-12
 *    to 9999-12-31 travel window"), so the model is handed a constraint that
 *    reads as a bug.
 *
 * The cost is real and worth naming: with only a departure date set, a proposal
 * departing in March passes the dates gate. That is the deliberate trade. The
 * gate stack's guarantee is about PRICES — that no number reaches the user that
 * a supplier did not quote — and a wrong upper bound cannot be un-guessed by the
 * model, which would be left re-searching against a window we made up. Refuse to
 * evaluate; never invent. Itinerary shape (is the departure the one the
 * traveller asked for?) belongs to the reviewer seat in plan 3.
 *
 * An INVERTED pair (departure after return) is also `null`. It is a notebook
 * inconsistency, not a proposal fault, and an empty window would reject every
 * proposal with a message pointing at the wrong thing.
 *
 * Dates are re-checked against `yyyy-mm-dd` even though `NotebookSchema`
 * already enforces it. `checkDates` compares date PREFIXES lexicographically —
 * that is only date ordering if both bounds really are `yyyy-mm-dd`, and a
 * notebook rehydrated from storage has not necessarily been back through the
 * schema. A bound we cannot compare is not a bound.
 */
export function constraintsFromNotebook(nb: Notebook): NotebookConstraints {
  const budget = nb.budget?.value ?? null
  const departure = calendarDate(nb.departureDate?.value)
  const ret = calendarDate(nb.returnDate?.value)

  return {
    budget,
    currency: budget?.currency ?? null,
    window: departure && ret && departure <= ret
      ? { earliest: departure, latest: ret }
      : null,
  }
}

function calendarDate(v: string | undefined | null): string | null {
  return typeof v === 'string' && CALENDAR_DATE.test(v) ? v : null
}
