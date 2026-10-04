import type { ChoicesContent } from '../results.js'

/**
 * The next-step chips (results UI pass 2, F2): a `choices` row with `questionId: 'next'` that
 * every desk reply built in CODE attaches alongside whatever it is showing her.
 *
 * Why they exist: every reply the office writes ends by telling her she can change anything by
 * typing, and then leaves her with a blank composer in front of a list of twenty flights. These
 * are the three or four things she most often wants next, pre-written as the message she would
 * have had to type. A click posts the LABEL as an ordinary user message (`ChoiceCardLive`), so
 * nothing downstream has to know these exist: the router classifies "Direct flights only" exactly
 * as it would if she had typed it (src/agents/router.ts's `next` arm).
 *
 * That is also why every label below has to be a sentence `routeMessage` can actually classify.
 * `direct_only`, `cheapest`, `evening`, `show_all` and `top_rated` read as filters;
 * `day_earlier`, `change_dates`, `central`, `cheaper_hotels` and `change_hotel_dates` read as new
 * searches.
 * The two exceptions are handled by the router itself rather than by Jev, because no typed
 * sentence could do what they do: `get_links` is a BUTTON on the summary, and `change_flight`
 * re-shows a stored row.
 *
 * `questionId: 'next'` is what tells the router this is not an answer to a question it asked
 * (an origin/destination/outbound card IS, and overrides intake with it), and what tells
 * `MessageBubble` to render ghost chips instead of a question card.
 */
export const NEXT_QUESTION_ID = 'next'

/**
 * The question text. Never shown — a `next` row renders as bare chips — but it is what
 * `renderChoicesNote` puts on the operator channel and what the chip group's `aria-label` reads,
 * so it says what the chips are rather than being empty.
 */
const NEXT_QUESTION = 'What next?'

export type NextStepSet =
  /** Flights were found and shown. */
  | 'flights'
  /** A flight search came back empty. */
  | 'zero_flights'
  /** A typed or clicked filter narrowed the list. */
  | 'filter'
  /** Hotels were found and shown, after a flight was chosen. */
  | 'hotels'
  /** The hotel search came back empty. */
  | 'zero_hotels'
  /** Both halves are chosen and the summary is pinned. */
  | 'summary'

/**
 * Spec section 3's range is 2 to 4 options and `ChoicesContentSchema` enforces it, so every set
 * here is between two and four by construction — a set that grew to five would fail
 * `buildAttachmentRows`'s own parse and take the turn down with it.
 */
const SETS: Record<NextStepSet, { id: string; label: string }[]> = {
  flights: [
    { id: 'direct_only', label: 'Direct flights only' },
    { id: 'cheapest', label: 'Cheapest first' },
    { id: 'day_earlier', label: 'Leave a day earlier' },
    { id: 'change_dates', label: 'Change the dates' },
  ],
  // Nothing was found, so "cheapest first" and "direct only" would narrow an empty list. The two
  // that can actually help are the two that change what was searched for.
  zero_flights: [
    { id: 'day_earlier', label: 'Leave a day earlier' },
    { id: 'change_dates', label: 'Change the dates' },
  ],
  filter: [
    { id: 'show_all', label: 'Show all flights again' },
    { id: 'evening', label: 'Evening departures' },
  ],
  // Hotels pass, section 6: `Top rated` joins the three, which is the fourth thing she reaches
  // for once a list of stays has ratings on it at all. Four is the ceiling spec section 3 sets.
  hotels: [
    { id: 'central', label: 'Near the centre' },
    { id: 'top_rated', label: 'Top rated' },
    { id: 'cheaper_hotels', label: 'Cheaper hotels' },
    { id: 'change_hotel_dates', label: 'Change hotel dates' },
  ],
  zero_hotels: [
    { id: 'central', label: 'Near the centre' },
    { id: 'change_hotel_dates', label: 'Change hotel dates' },
  ],
  summary: [
    { id: 'get_links', label: 'Accept the trip' },
    { id: 'change_flight', label: 'Change the flight' },
  ],
}

/** The `choices` attachment content for one set. */
export function nextSteps(set: NextStepSet): ChoicesContent {
  return { questionId: NEXT_QUESTION_ID, question: NEXT_QUESTION, options: SETS[set] }
}

/** The `choices` attachment row for one set, ready to go on an `AgentStep`. */
export function nextStepsAttachment(set: NextStepSet): { role: 'choices'; content: ChoicesContent } {
  return { role: 'choices', content: nextSteps(set) }
}

/**
 * The two option ids the router answers itself rather than handing to `routeMessage`.
 *
 * `get_links` names a button, not a message: the hand-off runs through
 * `POST /api/proposals/[id]/decide` from `PinnedSummary`, and no sentence typed into the composer
 * can start it. `change_flight` re-shows a stored `results` row, which is a read, not an intent.
 */
export const ROUTER_HANDLED_NEXT = new Set(['get_links', 'change_flight'])
