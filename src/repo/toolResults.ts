import type postgres from 'postgres'
import { money } from '../money.js'
import type { FlightDetail, HotelDetail, SearchParams, SupplierItem } from '../supplier/types.js'
import { FencedError, type Claim } from './turns.js'

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
 * ## Fenced, like every other write a worker makes
 *
 * It takes a `Claim` rather than three loose ids, and its `where exists` is the
 * same fencing token `beginToolCall` and `finishToolCall` carry
 * (src/repo/toolCalls.ts): the row only lands while `course.turns` still shows
 * this turn `running` at this claim's `attempts`. Without it, a worker
 * superseded between `beginToolCall` and `finishToolCall` still appends corpus
 * rows for a turn it no longer owns, and because `rehydrate` reads the NEWEST
 * fetch per id, a late row from the dead worker becomes the price a gate reads
 * for a proposal the live worker's model never saw. The row would be a true
 * record of a real fetch and still the wrong answer to the question the gate
 * asks.
 *
 * Zero rows back is therefore proof rather than an empty write, and it throws
 * `FencedError` for the reason `saveTurnState` does: a superseded worker that
 * carries on is what module 3 spent two lessons stopping. `corpusRunner`
 * (src/tools.ts) is what turns that throw into the turn's own ending.
 *
 * Idempotency is not this function's job. A resumed turn does not reach it
 * twice, because the tool-call ledger (`beginToolCall`, lesson 3.4) replays a
 * search it already ran rather than running it again, and `corpusRunner` sits
 * inside that. If it ever did run twice, the second run would append a second
 * identical fetch, which is a redundant row and not a wrong answer.
 */
export async function recordResults(
  sql: postgres.Sql,
  claim: Claim,
  args: { params: SearchParams; items: SupplierItem[] },
): Promise<number> {
  if (args.items.length === 0) return 0

  const rows = args.items.map((i) => ({
    source_id: i.sourceId,
    supplier: i.supplier,
    kind: i.kind,
    name: i.name,
    // Text, because a bigint is not JSON serialisable and would otherwise be
    // refused on the way to the parameter. The column is bigint and the value
    // is exact either way.
    price_minor: i.price.minor.toString(),
    currency: i.price.currency,
    price_basis: i.priceBasis,
    booking_url: i.bookingUrl,
    payload: i.detail,
    fetched_at: i.fetchedAt.toISOString(),
    ttl_seconds: i.ttlSeconds,
  }))

  // One fenced statement, which is `beginToolCall`'s own
  // `insert into ... select ... where exists (...)` widened from one row to
  // several. A `values` list cannot carry a `where`, so the rows arrive as one
  // jsonb parameter and `jsonb_to_recordset` names their columns and their
  // types; the four fields every row shares are bound once, beside it.
  //
  // One statement rather than a loop for two reasons: a search returns several
  // items and a per-row round trip is several network hops inside a turn
  // already being timed against a heartbeat, and a mid-loop failure cannot
  // leave half a search recorded.
  //
  // There is no `order by` on the function scan, so `seq` is assigned in the
  // order `jsonb_to_recordset` emits rows, which for a single array is array
  // order. Postgres holds that and no plan shape here can reorder one function
  // scan, but it is an assumption rather than a guarantee this statement makes,
  // and test/toolResults.test.ts leans on it: of two rows sharing a
  // `fetched_at`, the SECOND array element is the one rehydration takes. Which
  // duplicate wins carries no meaning beyond that.
  const out = await sql`
    insert into course.tool_results
      (conversation_id, user_id, turn_id, source_id, supplier, kind, name,
       price_minor, currency, price_basis, booking_url, search_params, payload,
       fetched_at, ttl_seconds)
    select ${claim.conversationId}, ${claim.userId}, ${claim.turnId},
           r.source_id, r.supplier, r.kind, r.name, r.price_minor, r.currency,
           r.price_basis, r.booking_url, ${sql.json(args.params as never)}::jsonb,
           r.payload, r.fetched_at, r.ttl_seconds
      from jsonb_to_recordset(${sql.json(rows as never)}::jsonb) as r(
             source_id text, supplier text, kind text, name text,
             price_minor bigint, currency char(3), price_basis text,
             booking_url text, payload jsonb, fetched_at timestamptz,
             ttl_seconds int)
     where exists (select 1 from course.turns
                    where id = ${claim.turnId}
                      and attempts = ${claim.attempts}
                      and status = 'running')
    returning id`
  if (out.length === 0) throw new FencedError(claim.turnId)
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

/**
 * The search that found each of these items, newest first, for the cashier's
 * re-quote.
 *
 * `Supplier.quote(sourceId, params)` re-runs the stored search and finds by
 * native id (src/supplier/kiwi.ts, src/supplier/searchapi.ts), so a re-quote
 * that could not reproduce its own search would have to invent one, and an
 * invented search is a different search: the same id may not be in its results
 * at all, and the cashier would call a live fare gone.
 *
 * A separate reader rather than a field on `SupplierItem`, because the params
 * are a property of the FETCH and not of the item: two searches can legitimately
 * return the same item, and only the corpus knows which one this row came from.
 */
export async function searchParamsFor(
  sql: postgres.Sql,
  conversationId: string,
  sourceIds: string[],
): Promise<Map<string, SearchParams>> {
  if (sourceIds.length === 0) return new Map()
  const rows = await sql<{ source_id: string; search_params: SearchParams }[]>`
    select distinct on (source_id) source_id, search_params
      from course.tool_results
     where conversation_id = ${conversationId}
       and source_id = any(${sourceIds})
     order by source_id, fetched_at desc, seq desc`
  return new Map(rows.map((r) => [r.source_id, r.search_params]))
}
