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
 *
 * ## DELIBERATE DEVIATION FROM SPEC §6 — read before relying on this table
 *
 * §6 calls `tool_results` "Untrimmed, append-only, retained at least as long as
 * `model_calls`". This is *upsert*-only, not append-only, and the difference is
 * real: when a re-search moves a price, the previous quote for that
 * `(conversation_id, source_id)` is OVERWRITTEN and gone. So this table can
 * answer "what price does the corpus hold for X now" but NOT "what price did a
 * gate run see for X at 14:03" for any proposal that was never saved. A gate
 * run's own record (`gate_results.detail` / `source_ids`) and an approved
 * proposal's rehydrated `proposals.itinerary` both survive; a REJECTED
 * proposal's exact inputs do not, once the item has been re-quoted.
 *
 * ### Why the deviation stands rather than being fixed here
 *
 * §6's own text does not conflict with itself here. The `tool_results` entry
 * is two sentences: the column list `(conversation_id, source_id), ...`
 * ends with a full stop, and "Untrimmed, append-only, retained at least as
 * long as `model_calls`" is a separate sentence about retention and
 * mutability, not a restatement of the key. §6 never calls
 * `(conversation_id, source_id)` a key, a primary key, or unique for this
 * table — contrast `tool_calls`' "(turn_id, call_id) primary key",
 * `turns`' "unique (conversation_id, idempotency_key)", and `link_clicks`'
 * "unique (proposal_id, item_id)". The bare tuple on `tool_results` states
 * the row's identifying grain, not an asserted constraint — and a lookup key
 * is not the same thing as a uniqueness constraint: a row-per-fetch table
 * still keeps `(conversation_id, source_id)` as its lookup key, it just loses
 * uniqueness on it. §6 also uses "append-only" elsewhere for `model_calls`
 * ("This table is the append-only cost ledger"), a table that is
 * unambiguously insert-only — so §6 means what it says here too.
 *
 * The uniqueness requirement comes from this branch's OWN PLAN, not the spec:
 * `docs/superpowers/plans/2026-08-16-supplier-port-and-gates.md` says
 * "(conversation_id, source_id) is the lookup key, and it must be unique so
 * rehydration is a point read" — asserting both append-only and unique in the
 * same breath — and then its DDL implements only the unique, upsert half.
 * The plan created the tension the spec doesn't have. This file's `on
 * conflict ... do update` is therefore a genuine, deliberate DEVIATION FROM
 * THE SPEC, not a resolution of a spec ambiguity — and because the spec is
 * not actually ambiguous, converting to row-per-fetch is owed, not merely an
 * option to weigh; every re-quote before it happens is unrecoverable loss.
 *
 * Reversing that decision means dropping a unique constraint from a LIVE table,
 * rewriting the gate stack's only corpus reader, and changing the corpus's
 * growth profile — a structural change to the central table of the branch, with
 * no consumer in this branch or the next that reads a superseded row. That is
 * work that deserves its own task and its own review, not a slot in a fix wave.
 *
 * ### What it costs if this was the wrong call
 *
 * Every re-quote between now and the change destroys one historical price. The
 * loss is silent and unrecoverable — unlike a code defect, it cannot be fixed
 * retroactively. If slice 2's replay needs "the price the gate actually saw",
 * the fix is a migration that drops `unique (conversation_id, source_id)`, adds
 * `(conversation_id, source_id, fetched_at desc)`, turns this into a plain
 * insert, and makes `rehydrate` below a `select distinct on (source_id) ...
 * order by source_id, fetched_at desc`. Doing it EARLY is much cheaper than
 * doing it late, because the rows lost in between never come back.
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

  // One row per source_id per statement. `on conflict do update` cannot touch a
  // row twice in the same command: postgres raises
  // `ON CONFLICT DO UPDATE command cannot affect row a second time`, which is
  // opaque, names neither the id nor the table, and takes the whole turn down
  // for what is a recoverable input shape. A supplier CAN legitimately return
  // the same native id twice (an itinerary offered under two fare families,
  // a property listed by two OTAs), and that is not a reason to lose the search.
  //
  // Newest wins, judged on `fetchedAt` rather than array position, because
  // position carries no meaning — the caller's array order is whatever the
  // supplier's response order was. Ties keep the LAST occurrence, which matches
  // what the upsert would have done had the duplicates arrived as two separate
  // statements. Deduped before the map so the discarded rows are never built.
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
