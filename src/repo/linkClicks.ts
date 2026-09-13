import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'

export type LinkClickRow = {
  id: string; itemId: string; supplier: string; url: string; trackingRef: string
  quotedMinor: bigint; currency: string
}

/**
 * Spec section 5, point 5: mint `link_clicks.id` FIRST and embed it as the
 * tracking ref, store the exact emitted URL. One transaction for the whole
 * set: a partial set would let her book half a trip through tracked links and
 * half through nothing. `unique (proposal_id, item_id)` makes a second mint
 * for the same proposal a loud error rather than a duplicate.
 */
export async function mintLinks(
  sql: postgres.Sql,
  args: {
    proposalId: string; turnId: string; userId: string
    links: { itemId: string; supplier: string; buildUrl: (trackingRef: string) => string; quotedMinor: bigint; currency: string }[]
  },
): Promise<LinkClickRow[]> {
  const rows = args.links.map((l) => {
    const id = randomUUID()
    const trackingRef = `gt_${id.replace(/-/g, '')}`
    return { id, proposal_id: args.proposalId, turn_id: args.turnId, user_id: args.userId,
      item_id: l.itemId, supplier: l.supplier, url: l.buildUrl(trackingRef), tracking_ref: trackingRef,
      quoted_minor: l.quotedMinor.toString(), currency: l.currency }
  })
  await sql.begin(async (tx) => { await tx`insert into link_clicks ${tx(rows)}` })
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, supplier: r.supplier, url: r.url,
    trackingRef: r.tracking_ref, quotedMinor: BigInt(r.quoted_minor), currency: r.currency }))
}

export async function linksForProposal(sql: postgres.Sql, proposalId: string): Promise<LinkClickRow[]> {
  const rows = await sql<{ id: string; item_id: string; supplier: string; url: string; tracking_ref: string; quoted_minor: string; currency: string }[]>`
    select id, item_id, supplier, url, tracking_ref, quoted_minor, currency
      from link_clicks where proposal_id = ${proposalId} order by rendered_at, item_id`
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, supplier: r.supplier, url: r.url,
    trackingRef: r.tracking_ref, quotedMinor: BigInt(r.quoted_minor), currency: r.currency }))
}
