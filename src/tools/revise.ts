import type postgres from 'postgres'
import type { z } from 'zod'
import type { ReviseComponent } from './registry.js'
import type { ItemRef } from '../gates/types.js'
import { loadProposal, type StoredItineraryItem } from '../repo/proposals.js'

export type ReviseInput = z.infer<typeof ReviseComponent>
export type ReviseResult =
  | { ok: true; refs: ItemRef[]; parentProposalId: string }
  | { ok: false; reason: string }

/**
 * Spec section 4: "scoped change to one component of an existing proposal
 * without a full re-plan." A code door over the corpus: it reads the parent's
 * itinerary and produces a NEW reference list. It never calls a supplier and
 * never trusts a value on the parent row beyond its ids and dates — the gates
 * rehydrate everything again on the way to the new row.
 */
export async function buildRevisedRefs(
  sql: postgres.Sql, conversationId: string, input: ReviseInput,
): Promise<ReviseResult> {
  const parent = await loadProposal(sql, conversationId, input.proposalId)
  if (parent === null) return { ok: false, reason: `No proposal ${input.proposalId} in this conversation.` }
  if (parent.itinerary.schemaVersion !== 1) return { ok: false, reason: 'This proposal was saved in a shape this desk cannot revise.' }
  const items = parent.itinerary.items

  if (input.change.kind === 'swap') {
    const { slot, sourceId } = input.change
    if (!items.some((i) => i.slot === slot)) {
      return { ok: false, reason: `Proposal has no "${slot}" slot; its slots are ${items.map((i) => i.slot).join(', ')}.` }
    }
    return {
      ok: true, parentProposalId: parent.id,
      refs: items.map((i) => ({ sourceId: i.slot === slot ? sourceId : i.sourceId, quantity: i.quantity, slot: i.slot })),
    }
  }

  const { days } = input.change
  const unresolved: string[] = []
  const refs: ItemRef[] = []
  for (const i of items) {
    const id = await findShifted(sql, conversationId, i, days)
    if (id === null) unresolved.push(i.slot)
    else refs.push({ sourceId: id, quantity: i.quantity, slot: i.slot })
  }
  if (unresolved.length > 0) {
    return { ok: false, reason: `No search results for the shifted dates in slot(s) ${unresolved.join(', ')}. `
      + `Search those dates first (explore_flights / explore_hotels), then revise again.` }
  }
  return { ok: true, refs, parentProposalId: parent.id }
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The same supplier, the same identity, the shifted dates — found in the
 * corpus or not at all. Flight identity is the flight-number list in order;
 * hotel identity is the name (the property token differs per search on some
 * suppliers, and the name is what she recognises). Newest row wins.
 */
async function findShifted(
  sql: postgres.Sql, conversationId: string, item: StoredItineraryItem, days: number,
): Promise<string | null> {
  if (item.detail.kind === 'flight') {
    const dep = shiftDate(item.detail.outbound.departureLocal.slice(0, 10), days)
    const rows = await sql<{ source_id: string; payload: { outbound: { departureLocal: string; flightNumbers: string[] } } }[]>`
      select source_id, payload from tool_results
       where conversation_id = ${conversationId} and supplier = ${item.supplier} and kind = 'flight'
         and payload->'outbound'->>'departureLocal' like ${dep + '%'}
       order by fetched_at desc, id desc`
    const want = item.detail.outbound.flightNumbers.join('+')
    const hit = rows.find((r) => r.payload.outbound.flightNumbers.join('+') === want)
    return hit ? hit.source_id : null
  }
  const checkIn = shiftDate(item.detail.checkIn, days), checkOut = shiftDate(item.detail.checkOut, days)
  const rows = await sql<{ source_id: string }[]>`
    select source_id from tool_results
     where conversation_id = ${conversationId} and supplier = ${item.supplier} and kind = 'hotel'
       and name = ${item.name} and payload->>'checkIn' = ${checkIn} and payload->>'checkOut' = ${checkOut}
     order by fetched_at desc, id desc limit 1`
  return rows[0]?.source_id ?? null
}
