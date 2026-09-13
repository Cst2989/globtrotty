import type postgres from 'postgres'
import { loadProposal, type ProposalRow, type StoredItineraryItem } from '../repo/proposals.js'
import { linksForProposal, mintLinks, type LinkClickRow } from '../repo/linkClicks.js'
import { formatMoney, money } from '../money.js'
import { sanitizeSourceId } from '../sanitize.js'
import { BookingUrlError } from '../supplier/urls.js'
import type { Supplier, SupplierItem } from '../supplier/types.js'

/** Spec section 5, point 1. One definition; the plan 4 UI reads it too. */
export const ACCEPT_WINDOW_MS = 30 * 60_000
/** ±0.5% in basis points. Integer arithmetic only. */
export const TOLERANCE_BPS = 50n

export type CashierDeps = { sql: postgres.Sql; flights: Supplier; hotels: Supplier; now: () => number }

/** |new − old| × 10 000 ≤ old × 50, so "exactly 0.5%" passes and one bp over does not. */
export function withinTolerance(oldMinor: bigint, newMinor: bigint): boolean {
  const diff = newMinor > oldMinor ? newMinor - oldMinor : oldMinor - newMinor
  return diff * 10_000n <= oldMinor * TOLERANCE_BPS
}

/**
 * Spec section 5, point 3: "per item and on item identity, not just on the
 * sum. A total that fell because a refundable fare became basic economy is a
 * downgrade she never accepted." Flight identity: supplier, id, and the
 * flight-number lists in order, both directions. Hotel identity: supplier, id,
 * name, check-in and check-out.
 */
export function sameIdentity(stored: StoredItineraryItem, fresh: SupplierItem): boolean {
  if (stored.supplier !== fresh.supplier || stored.sourceId !== fresh.sourceId || stored.kind !== fresh.kind) return false
  const a = stored.detail, b = fresh.detail
  if (a.kind === 'flight' && b.kind === 'flight') {
    const legs = (x: typeof a) => [x.outbound.flightNumbers.join('+'), x.inbound ? x.inbound.flightNumbers.join('+') : '',
      x.outbound.departureLocal.slice(0, 10), x.inbound ? x.inbound.departureLocal.slice(0, 10) : ''].join('|')
    return legs(a) === legs(b)
  }
  if (a.kind === 'hotel' && b.kind === 'hotel') {
    return stored.name === fresh.name && a.checkIn === b.checkIn && a.checkOut === b.checkOut
  }
  return false
}

type Refusal = { ok: false; text: string }
type Verified = { ok: true; fresh: Map<string, SupplierItem> }

/**
 * The cashier. Takes a proposal id and nothing else. Every refusal is text the
 * model can pass on; every success ends in tracked links.
 *
 * Idempotent through `link_clicks`: if links already exist for this proposal
 * the stored set is returned and no supplier is called. The worker's
 * `tool_calls` pending row (src/worker.ts) is the other half — a resumed turn
 * that died mid-mint reports `ambiguous` and the turn fails as `fenced` rather
 * than minting twice. Plan 3b deviation 1 records why the mint and the
 * tool_calls finish are not one transaction.
 *
 * Moves no money. Writes no spend.
 */
export async function handOff(
  deps: CashierDeps, ctx: { conversationId: string; userId: string; turnId: string }, proposalId: string,
): Promise<string> {
  const { sql } = deps
  const now = new Date(deps.now())
  const p = await loadProposal(sql, ctx.conversationId, proposalId)
  if (p === null) return `No proposal ${sanitizeSourceId(proposalId)} in this conversation.`

  const existing = await linksForProposal(sql, p.id)
  if (existing.length > 0) return render(p, existing, now, verifiedLabel(deps, p))

  if (p.decision === 'reject') return 'She rejected this proposal. Ask what to change, or propose another.'
  if (p.decision !== 'accept' || p.decidedAt === null) {
    return 'This proposal has not been accepted. Hand-off happens only after she accepts in chat; do not ask her to say it to you — the card has the button.'
  }
  if (now.getTime() - p.decidedAt.getTime() > ACCEPT_WINDOW_MS) {
    return 'She accepted this more than 30 minutes ago; prices may have moved. Ask her to accept again on a fresh proposal.'
  }
  if (p.itinerary.schemaVersion !== 1) return 'This proposal was saved in a shape the cashier cannot read.'

  const verify = await requote(deps, p, now)
  if (!verify.ok) return verify.text

  const links = await mintLinks(sql, {
    proposalId: p.id, turnId: ctx.turnId, userId: ctx.userId,
    links: p.itinerary.items.map((i) => {
      const fresh = verify.fresh.get(i.sourceId)
      const quoted = fresh ? fresh.price.minor : BigInt(i.priceMinor)
      const sup = supplierFor(deps, i)
      const item: SupplierItem = fresh ?? storedAsItem(i)
      return { itemId: i.sourceId, supplier: i.supplier, quotedMinor: quoted, currency: i.currency,
        buildUrl: (ref: string) => sup.bookingUrl(item, ref) }
    }),
  }).catch((err: unknown) => { if (err instanceof BookingUrlError) return err; throw err })
  if (links instanceof BookingUrlError) return `Could not build a booking link: ${links.message}. Escalate to a human.`
  return render(p, links, now, verifiedLabel(deps, p))
}

function supplierFor(deps: CashierDeps, i: StoredItineraryItem): Supplier {
  return i.kind === 'flight' ? deps.flights : deps.hotels
}

function verifiedLabel(deps: CashierDeps, p: ProposalRow): boolean {
  return p.itinerary.items.every((i) => supplierFor(deps, i).capabilities.mayRequote)
}

async function requote(deps: CashierDeps, p: ProposalRow, now: Date): Promise<Verified | Refusal> {
  const fresh = new Map<string, SupplierItem>()
  const block = (i: StoredItineraryItem, why: string): Refusal =>
    ({ ok: false, text: `Could not verify ${sanitizeSourceId(i.sourceId)} (${i.slot}): ${why}. Nothing was handed off. Re-search that slot and propose again, or escalate.` })
  for (const i of p.itinerary.items) {
    const sup = supplierFor(deps, i)
    if (sup.name !== i.supplier) return block(i, `this desk has no supplier named ${i.supplier}`)
    if (!sup.capabilities.mayRequote) continue                    // disclosure path; nothing to verify
    if (i.searchParams === null) return block(i, 'no stored search to re-run')
    let q
    try { q = await sup.quote(i.sourceId, i.searchParams) } catch (err) { return block(i, `the supplier failed (${(err as Error).message})`) }
    if (q.status === 'gone') return block(i, 'it is no longer offered')
    if (q.status === 'unavailable') return block(i, q.reason)
    const item = q.item
    if (item.price.currency !== i.currency) return block(i, `it is now quoted in ${item.price.currency}, a different currency than the ${i.currency} she accepted`)
    if (!sameIdentity(i, item)) return block(i, 'the offer changed (different flights or dates) even though the id matched')
    if (now.getTime() - item.fetchedAt.getTime() > item.ttlSeconds * 1000) return block(i, 'the re-quote came back already stale')
    const old = BigInt(i.priceMinor)
    if (!withinTolerance(old, item.price.minor)) {
      return { ok: false, text: `The price of ${sanitizeSourceId(i.sourceId)} (${i.slot}) moved from ${formatMoney(money(old, i.currency))} `
        + `to ${formatMoney(item.price)}, outside the ±0.5% we allow. Nothing was handed off. Tell her, then re-search and propose again if she wants to continue.` }
    }
    fresh.set(i.sourceId, item)
  }
  return { ok: true, fresh }
}

function storedAsItem(i: StoredItineraryItem): SupplierItem {
  return { sourceId: i.sourceId, supplier: i.supplier, kind: i.kind, name: i.name, price: money(BigInt(i.priceMinor), i.currency),
    priceBasis: i.priceBasis, fetchedAt: new Date(i.fetchedAt), ttlSeconds: 0, bookingUrl: null, detail: i.detail }
}

/**
 * What the model passes on. Spec section 5, point 4: when nothing was
 * re-quoted the copy is DISCLOSURE, never verification, and every price
 * renders with its age.
 */
function render(p: ProposalRow, links: LinkClickRow[], now: Date, verified: boolean): string {
  const byId = new Map(p.itinerary.items.map((i) => [i.sourceId, i]))
  const lines = links.map((l) => {
    const i = byId.get(l.itemId)
    const ageMin = i ? Math.max(0, Math.round((now.getTime() - new Date(i.fetchedAt).getTime()) / 60_000)) : 0
    const price = formatMoney(money(l.quotedMinor, l.currency))
    return `- ${i?.slot ?? l.itemId}: ${i?.name ?? ''} — ${price}${verified ? '' : ` (found ${ageMin} min ago)`} — ${l.url}`
  })
  const head = verified
    ? 'Verified just now against the suppliers; every item is still offered at the price she accepted (within 0.5%).'
    : `These were the prices when we found them. Prices move; tell her to check the total before she pays.`
  const warn = p.gateOutcome === 'shipped_unapproved' && p.reviewIssues.length > 0
    ? `\n\nThe reviewer did not approve this offer: ${p.reviewIssues.join('; ')}. Say so plainly before the links.` : ''
  return `${head}${warn}\n\nGive her these links, one per line, exactly as written:\n${lines.join('\n')}\n\nThis is the point of no return: do not re-quote, revise, or re-propose this set.`
}
