import type postgres from 'postgres'
import { money } from '../money.js'
import type { SupplierItem, SearchParams, FlightDetail, HotelDetail } from '../supplier/types.js'

type Row = {
  source_id: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  price_minor: string; currency: string; price_basis: 'total' | 'pre_tax'
  booking_url: string | null; payload: FlightDetail | HotelDetail
  fetched_at: Date; ttl_seconds: number
}

/**
 * Appends a search's results to the provenance corpus. Idempotent on
 * (conversation_id, source_id): a resumed turn that re-runs the same search
 * must not fail on a duplicate key.
 *
 * The conflict path UPDATES rather than doing nothing, deliberately. When the
 * freshness gate says "these prices are older than we'll quote, re-search
 * them", the re-search has to be able to move both the price and `fetched_at`
 * — a `do nothing` would leave the stale row in place and the gate would
 * reject the retry for exactly the reason the retry was meant to fix.
 */
export async function recordResults(
  sql: postgres.Sql,
  args: {
    conversationId: string
    userId: string
    turnId: string | null
    params: SearchParams
    items: SupplierItem[]
  },
): Promise<number> {
  if (args.items.length === 0) return 0
  const rows = args.items.map((i) => ({
    conversation_id: args.conversationId,
    user_id: args.userId,
    turn_id: args.turnId,
    source_id: i.sourceId,
    supplier: i.supplier,
    kind: i.kind,
    name: i.name,
    price_minor: i.price.minor.toString(), // bigint is not Serializable
    currency: i.price.currency,
    price_basis: i.priceBasis,
    booking_url: i.bookingUrl,
    search_params: sql.json(args.params as never),
    payload: sql.json(i.detail as never),
    fetched_at: i.fetchedAt,
    ttl_seconds: i.ttlSeconds,
  }))
  const out = await sql`
    insert into tool_results ${sql(rows)}
    on conflict (conversation_id, source_id) do update set
      price_minor = excluded.price_minor,
      currency    = excluded.currency,
      price_basis = excluded.price_basis,
      booking_url = excluded.booking_url,
      payload     = excluded.payload,
      search_params = excluded.search_params,
      fetched_at  = excluded.fetched_at,
      ttl_seconds = excluded.ttl_seconds
    returning source_id`
  return out.length
}

/**
 * The gate's only reader. Returns a Map so a caller can tell "present" from
 * "absent" without a second query — an id that is absent is precisely the
 * provenance failure, so it must never be silently defaulted.
 *
 * Scoped to one conversation on purpose: a source id seen in someone else's
 * conversation is not provenance for this one.
 */
export async function rehydrate(
  sql: postgres.Sql,
  conversationId: string,
  sourceIds: string[],
): Promise<Map<string, SupplierItem>> {
  if (sourceIds.length === 0) return new Map()
  const rows = await sql<Row[]>`
    select source_id, supplier, kind, name, price_minor, currency, price_basis,
           booking_url, payload, fetched_at, ttl_seconds
      from tool_results
     where conversation_id = ${conversationId}
       and source_id = any(${sourceIds})`
  const out = new Map<string, SupplierItem>()
  for (const r of rows) {
    out.set(r.source_id, {
      sourceId: r.source_id,
      supplier: r.supplier,
      kind: r.kind,
      name: r.name,
      price: money(BigInt(r.price_minor), r.currency),
      priceBasis: r.price_basis,
      fetchedAt: r.fetched_at,
      ttlSeconds: r.ttl_seconds,
      bookingUrl: r.booking_url,
      detail: r.payload,
    })
  }
  return out
}
