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
import { maskDisplayName } from '../sanitize.js'
import type { NextStepSet } from './nextSteps.js'
import type { StoredItinerary } from '../repo/proposals.js'
import { isHotel, type SupplierItem } from '../supplier/types.js'

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

/**
 * The one line the DRIVER is told about where the trip is, so a typed question is answered in
 * context instead of as if the conversation had just started (section 8d).
 *
 * It joins the notebook and the expired notice in the driver's volatile suffix: per-turn, after
 * the cache breakpoint, fixed English with no id and no supplier string in it.
 */
export function stageNote(stage: Stage): string {
  switch (stage) {
    case 'flights':
      return 'Stage: flights, nothing chosen yet.'
    case 'hotels':
      return 'Stage: hotels, flight chosen.'
    case 'summary':
      return 'Stage: summary, flight and stay both chosen.'
  }
}

/** 'at 1.2 km' / 'at 820 m'. One decimal under ten kilometres, whole numbers above. */
function distanceWords(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

/**
 * What the desk says once a list of stays is on screen (section 8c).
 *
 * The author's complaint was that the conversation STOPPED: "Nice choice. Here are hotels in
 * Tokyo for 20 Nov to 6 Dec, 16 nights, two adults." is a receipt for the search, not a
 * contribution to the conversation, and it left her with a blank composer in front of eighteen
 * cards. This says what is actually in the list — how many are hotels and how many are whole
 * places, and which one is closest to the centre — and then asks the question a travel agent
 * would ask next.
 *
 * `city` is the bundled place table's own name. The one supplier-authored string that reaches
 * her is the stay's name, through `maskDisplayName`, exactly as the cards already show it.
 * Returns `null` when the list is too thin to say anything interesting about, and the caller
 * keeps its plainer sentence.
 */
export function hotelsFoundReply(city: string, items: SupplierItem[]): string | null {
  if (items.length === 0) return null
  const stays = items.filter(isHotel)
  const rentals = stays.filter((i) => i.detail.propertyType === 'rental').length
  const hotels = stays.filter((i) => i.detail.propertyType === 'hotel').length

  // Further out than this and "the closest to the centre" is not a recommendation, it is an
  // apology — and a stay the supplier placed somewhere implausible (or a place table whose
  // centre is wrong) would otherwise produce a confident sentence about a hotel 11,000 km from
  // Tokyo. Past the cap the clause is simply left out.
  const NEAR_ENOUGH_KM = 50
  const placed = stays
    .filter((i) => i.detail.distanceKm !== null && i.detail.distanceKm <= NEAR_ENOUGH_KM)
    .sort((a, b) => a.detail.distanceKm! - b.detail.distanceKm!)
  const closest = placed[0] ?? null

  // The semicolon joins the two clauses when both exist, and becomes a full stop when the
  // second one is missing — a sentence this office prints should never end on a semicolon.
  const hasNearest = closest !== null
  const mix = hotels > 0 && rentals > 0
    ? ` ${hotels} ${hotels === 1 ? 'is a hotel' : 'are hotels'}, `
      + `${rentals} ${rentals === 1 ? 'is a rental' : 'are rentals'}${hasNearest ? ';' : '.'}`
    : ''
  const nearest = closest === null
    ? ''
    : `${mix === '' ? ' The' : ' the'} closest to the centre is ${maskDisplayName(closest.name)} `
      + `at ${distanceWords(closest.detail.distanceKm!)}.`

  return `I found ${items.length} ${items.length === 1 ? 'place' : 'places'} in ${city} for those `
    + `dates.${mix}${nearest}`
    + ' Pick one, or tell me what matters: area, budget, breakfast.'
}

/**
 * What the desk says after a filter: how many are left and the best thing among them, rather
 * than only the arithmetic. Same shape, same reason, same masking.
 */
export function filterReply(left: number, total: number, description: string, cheapest: { name: string; price: string } | null): string {
  const head = `Showing ${left} of ${total}: ${description}.`
  if (left === 0 || cheapest === null) return head
  return `${head} The cheapest is ${maskDisplayName(cheapest.name)} at ${cheapest.price}.`
}
