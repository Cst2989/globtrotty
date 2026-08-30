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
 * Appends a search's results to the provenance corpus, per spec §6:
 * `tool_results` is "untrimmed, append-only, retained at least as long as
 * `model_calls`". Every call to this function is a plain insert — one row per
 * fetch. A re-search that moves a price adds a new row rather than overwriting
 * the old one, so the previous quote for a `(conversation_id, source_id)`
 * stays readable forever. (Migration 0011 dropped the
 * `unique (conversation_id, source_id)` constraint that used to force an
 * upsert here; every re-quote before that migration destroyed the prior row
 * unrecoverably — see backlog 2.1.)
 *
 * Dedup is per-fetch only, not across fetches. A supplier can legitimately
 * return the same native id twice in one response (an itinerary offered under
 * two fare families, a property listed by two OTAs); `newestBySourceId` below
 * collapses those down to one row per `source_id` per call, both because two
 * rows for the same fetch carry no extra information and because `on conflict`
 * can't touch a row twice in one statement anyway. It does NOT collapse across
 * separate calls — that would defeat the point of this migration.
 *
 * `rehydrate` below takes the newest row per `source_id` (via
 * `distinct on ... order by source_id, fetched_at desc, id desc`), so a gate
 * asking "what does the corpus hold for X now" gets the latest fetch without
 * needing to know how many fetches happened.
 *
 * Growth is unbounded from here — no reaper exists yet for `tool_results` or
 * `model_calls`, and adding one is deliberately out of scope for this change;
 * see docs/backlog-plan.md.
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

  // One row per source_id per statement — one fetch, one row per id. A supplier
  // CAN legitimately return the same native id twice in one response (an
  // itinerary offered under two fare families, a property listed by two OTAs);
  // that's a supplier quirk within a single fetch, not two fetches, so it does
  // not get two rows. This dedup is scoped to THIS call only — it never
  // collapses rows across separate calls to `recordResults`, which is what
  // append-only means.
  //
  // Newest wins, judged on `fetchedAt` rather than array position, because
  // position carries no meaning — the caller's array order is whatever the
  // supplier's response order was. Ties keep the LAST occurrence. Deduped
  // before the map so the discarded rows are never built.
  const newestBySourceId = new Map<string, SupplierItem>()
  for (const i of args.items) {
    const seen = newestBySourceId.get(i.sourceId)
    if (!seen || i.fetchedAt.getTime() >= seen.fetchedAt.getTime()) {
      newestBySourceId.set(i.sourceId, i)
    }
  }

  const rows = [...newestBySourceId.values()].map((i) => ({
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
    select distinct on (source_id)
           source_id, supplier, kind, name, price_minor, currency, price_basis,
           booking_url, payload, fetched_at, ttl_seconds
      from tool_results
     where conversation_id = ${conversationId}
       and source_id = any(${sourceIds})
     order by source_id, fetched_at desc, id desc`
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
