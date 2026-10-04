/**
 * Polish pass, section 8: which stage of the trip the conversation is in, and the copy that
 * follows from it.
 *
 * The complaint this answers: after a flight was chosen, a background refresh wrote "You asked
 * to refresh prices" into the thread and the desk replied "Prices refreshed." with FLIGHT chips
 * — `Direct flights only`, `Cheapest first`, `Leave a day earlier` — while the screen was a list
 * of Tokyo hotels. Every code-written reply in this office picked its words from WHICH HANDLER
 * was running rather than from where she actually is, and the chat read as a machine answering
 * the last button press.
 *
 * So the stage is a fact about the conversation, read once per reply, and the words are a
 * function of it. The reading is deliberately narrow: a conversation is at `summary` once a
 * proposal holding BOTH a flight and a stay exists, at `hotels` once an accepted flights-only
 * proposal exists, and at `flights` otherwise. Nothing here reads a message, so nothing she or a
 * supplier wrote can move the stage.
 */
import type postgres from 'postgres'
import type { NextStepSet } from './nextSteps.js'
import type { StoredItinerary } from '../repo/proposals.js'

export type Stage = 'flights' | 'hotels' | 'summary'

/**
 * The stage, from the proposals table alone.
 *
 * ACCEPTED is the test for the flights half because that is what `handleChooseFlight` writes and
 * what `handleChooseHotel` reads back; the combined proposal is deliberately left UNDECIDED
 * ("Get booking links" is the acceptance, not the hotel click — spec section 9), so a combined
 * proposal counts whatever its decision says. A rejected combination leaves her back at
 * `hotels`, which is where the list still is.
 */
export async function conversationStage(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<Stage> {
  const rows = await sql<{ itinerary: StoredItinerary; decision: string | null }[]>`
    select itinerary, decision from proposals
     where conversation_id = ${conversationId} and user_id = ${userId}
     order by created_at desc, id desc
     limit 20`

  let flightAccepted = false
  for (const row of rows) {
    const slots = new Set((row.itinerary?.items ?? []).map((i) => i.slot))
    if (slots.has('stay')) return 'summary'
    if (slots.has('flight') && row.decision === 'accept') flightAccepted = true
  }
  return flightAccepted ? 'hotels' : 'flights'
}

/** The next-step chips that belong to a stage. */
export function nextStepsForStage(stage: Stage): NextStepSet {
  if (stage === 'summary') return 'summary'
  return stage === 'hotels' ? 'hotels' : 'flights'
}

/**
 * The chips to put under a reply that is SHOWING a list.
 *
 * The stage decides, except that a reply carrying a list of stays gets stay chips whatever the
 * proposals table says — the author's complaint was `Direct flights only` and `Cheapest first`
 * under a list of Tokyo hotels, and that is wrong for the same reason in either direction. Once
 * both halves are chosen the summary's own two chips win: there is no list left to narrow.
 */
export function nextStepsForList(stage: Stage, rowKind: 'flights' | 'hotels'): NextStepSet {
  if (stage === 'summary') return 'summary'
  return rowKind === 'hotels' ? 'hotels' : 'flights'
}

/**
 * What the desk says after a refresh, given the stage and which list was re-run.
 *
 * The empty string means SAY NOTHING: a flights refresh while she is choosing a hotel is
 * bookkeeping, and bookkeeping does not get a turn in the conversation. `handleRefresh` turns an
 * empty string into a silent park.
 */
export function refreshReplyFor(stage: Stage, rowKind: 'flights' | 'hotels'): string {
  if (rowKind === 'hotels') return 'Hotel prices are up to date.'
  if (stage === 'flights') return 'Prices refreshed.'
  // Flights, at a stage where the flight is already chosen: the only thing worth saying is that
  // the price of HER flight moved, and `handleRefresh` has no cheap way to know that here. Until
  // it does, silence beats a sentence about a list she is no longer looking at.
  return ''
}

/**
 * The price of the chosen flight, said once, when a background re-quote found it had moved.
 * Fixed English around one formatted amount; the amount is this office's own `formatMoney`
 * output, never a supplier string.
 */
export function chosenFlightMovedTo(formattedPrice: string): string {
  return `Your chosen flight is now ${formattedPrice}.`
}
