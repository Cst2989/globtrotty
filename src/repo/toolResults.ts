import type postgres from 'postgres'
import { money } from '../money.js'
import type { FlightDetail, HotelDetail, SearchParams, SupplierItem } from '../supplier/types.js'

type Row = {
  source_id: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  price_minor: string; currency: string; price_basis: 'total' | 'pre_tax'
  booking_url: string | null; payload: FlightDetail | HotelDetail
  fetched_at: Date; ttl_seconds: number
}

/**
 * Appends a search's results to the provenance corpus. One row per item per
 * fetch, and nothing is ever overwritten.
 *
 * A plain insert, not an upsert, and that is the whole design. The upsert shape,
 * `unique (conversation_id, source_id)` with `on conflict do update`, is what
 * the product's main branch shipped, and it costs one historical price every
 * time an item is re-searched: the table can then answer "what does the corpus
 * hold for X now" and cannot answer "what price did the gate see for X at
 * 14:03", which is the first question anyone replaying a recorded conversation
 * asks. The loss is silent and unrecoverable, unlike a code defect. This branch
 * has no live rows, so it takes the row-per-fetch shape now instead of owing
 * the conversion later.
 *
 * Two things fall out of that, and both are wanted. There is no deduplication
 * here, because there is no conflict to avoid: a supplier that legitimately
 * returns one native id twice in a response (an itinerary under two fare
 * families, a property listed by two OTAs) writes two rows, and `rehydrate`
 * below picks the newest. And `recordResults` returns the number of ROWS
 * written, which is `items.length` and not the number of distinct ids.
 *
 * Idempotency is not this function's job. A resumed turn does not reach it
 * twice, because the tool-call ledger (`beginToolCall`, lesson 3.4) replays a
 * search it already ran rather than running it again, and `corpusRunner`
 * (src/tools.ts) sits inside that. If it ever did run twice, the second run
 * would append a second identical fetch, which is a redundant row and not a
 * wrong answer.
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
    // Text, because a bigint is not JSON serialisable and postgres.js would
    // otherwise refuse the parameter. The column is bigint and the value is
    // exact either way.
    price_minor: i.price.minor.toString(),
    currency: i.price.currency,
    price_basis: i.priceBasis,
    booking_url: i.bookingUrl,
    search_params: sql.json(args.params as never),
    payload: sql.json(i.detail as never),
    fetched_at: i.fetchedAt,
    ttl_seconds: i.ttlSeconds,
  }))

  // One multi-row insert rather than a loop: a search returns several items and
  // a per-row round trip is several network hops inside a turn already being
  // timed against a heartbeat. It is also one statement, so a mid-loop failure
  // cannot leave half a search recorded.
  const out = await sql`insert into course.tool_results ${sql(rows)} returning id`
  return out.length
}

/**
 * The gate's only reader, and the newest fetch of each id it was asked for.
 *
 * Returns a Map so a caller can tell "present" from "absent" without a second
 * query: an id that is absent is precisely the provenance failure lesson 4.4
 * reports, so it must never be silently defaulted to anything.
 *
 * Scoped to one conversation on purpose: a source id seen in someone else's
 * conversation is not provenance for this one.
 *
 * `distinct on (source_id)` with a matching `order by` is Postgres's own
 * newest-per-group, and the order clause is the whole of the correctness here.
 * `fetched_at desc` picks the newest fetch; `seq desc` breaks a tie between two
 * rows from the same call, which is a real case (one supplier response carrying
 * one native id twice) and not a defensive flourish. Without the tiebreak, two
 * rows sharing a timestamp resolve to whichever the planner reached first.
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
      from course.tool_results
     where conversation_id = ${conversationId}
       and source_id = any(${sourceIds})
     order by source_id, fetched_at desc, seq desc`
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
      // Read back as jsonb the type system never saw written. Nothing else
      // writes this table today, so every payload here came from a typed
      // SupplierItem through recordResults above; the day something else writes
      // it, the fix is to validate on the way OUT of this function rather than
      // to wrap every gate in a try/catch.
      detail: r.payload,
    })
  }
  return out
}
