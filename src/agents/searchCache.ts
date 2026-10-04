/**
 * Polish pass, section 10: an identical search, run again inside its own freshness window,
 * reuses what this traveller already has instead of paying a supplier for the same answer.
 *
 * The case that made it necessary: she sends the same brief twice, or chooses a flight in one
 * conversation and starts another to the same city on the same dates, and the office runs the
 * whole search again — a supplier call, a Jev re-rank, and a set of prices identical to the ones
 * sitting in `tool_results` from four minutes ago.
 *
 * The cache IS `tool_results`. There is no second store and no new table: the corpus is already
 * append-only, already carries the exact `search_params` each row was fetched for, and already
 * carries `fetched_at`/`ttl_seconds`, which is the freshness every consumer downstream reads. So
 * a lookup is one query against it, and a hit is a copy of those rows into the conversation that
 * asked — WITH their original timestamps, so the freshness gate still sees the true age of every
 * price and nothing is laundered into looking newer than it is.
 *
 * Scoped to one user, never one conversation: `rehydrate` is conversation-scoped on purpose (a
 * source id seen in someone else's conversation is not provenance for this one), and this is the
 * one place that boundary is crossed deliberately — within a single traveller's own account,
 * between her own conversations, for prices she herself was just quoted.
 *
 * Trust boundary: the lookup matches on a jsonb value this office wrote, never on anything she
 * typed. Nothing from the cached rows reaches her or the model that would not have reached her
 * from a live search of the same parameters.
 */
import { createHash } from 'node:crypto'
import type postgres from 'postgres'
import { money } from '../money.js'
import type { FlightDetail, HotelDetail, SearchParams, SupplierItem } from '../supplier/types.js'
import { DEFAULT_MAX_AGE_SECONDS, HOTEL_MAX_AGE_SECONDS } from '../supplier/types.js'

/**
 * How long a previous answer stands in for a new one, per kind.
 *
 * Deliberately the same numbers as the suppliers' own ttls (`DEFAULT_MAX_AGE_SECONDS`,
 * `HOTEL_MAX_AGE_SECONDS`): a cached result is reused for exactly as long as a result she
 * already has on screen is considered current, and not one second longer. Any other window
 * would mean two different answers in this codebase to "is this price still good?".
 */
export function cacheWindowMs(kind: SearchParams['kind']): number {
  return (kind === 'hotel' ? HOTEL_MAX_AGE_SECONDS : DEFAULT_MAX_AGE_SECONDS) * 1000
}

/**
 * A short, stable fingerprint of one search — for the LOG LINE, and for nothing else.
 *
 * The lookup itself matches on jsonb equality (`search_params = $1`), which is exact,
 * key-order-independent and done by Postgres. A hash would only add a way for the two to
 * disagree. This exists so "cache hit a1b2c3d4" and "cache miss a1b2c3d4" in a function log can
 * be read as the same search without printing a supplier query into it.
 */
export function paramsHash(params: SearchParams): string {
  const canonical = JSON.stringify(params, Object.keys(params as object).sort())
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

type Row = {
  source_id: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  price_minor: string; currency: string; price_basis: 'total' | 'pre_tax'
  booking_url: string | null; payload: FlightDetail | HotelDetail
  fetched_at: Date; ttl_seconds: number
}

/**
 * The items an identical search produced for this traveller inside the window, or `null` for a
 * miss. Newest row per `source_id`, the same rule `rehydrate` applies.
 *
 * A row is only a hit while it is still inside its OWN ttl as well as the window — the two are
 * the same number today, and the belt-and-braces check means they can stop being the same
 * without this function quietly serving a price the rest of the office calls expired.
 */
export async function cachedSearch(
  sql: postgres.Sql, userId: string, params: SearchParams, now: Date,
): Promise<SupplierItem[] | null> {
  const cutoff = new Date(now.getTime() - cacheWindowMs(params.kind))
  const rows = await sql<Row[]>`
    select distinct on (source_id)
           source_id, supplier, kind, name, price_minor, currency, price_basis,
           booking_url, payload, fetched_at, ttl_seconds
      from tool_results
     where user_id = ${userId}
       and search_params = ${sql.json(params as never)}
       and fetched_at > ${cutoff}
     order by source_id, fetched_at desc, id desc
     limit 200`
  if (rows.length === 0) return null

  const items = rows
    .filter((r) => r.fetched_at.getTime() + r.ttl_seconds * 1000 > now.getTime())
    .map((r): SupplierItem => ({
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
    }))
  return items.length === 0 ? null : items
}

/**
 * One line per search, so "why did this turn cost a supplier call?" is answerable from a
 * function log without any of the search's own contents being in it.
 *
 * `console.log`, deliberately: this office has no logger, Netlify captures stdout per
 * invocation, and a hit/miss line is operational noise, not an event worth a table.
 */
export function logCache(hit: boolean, params: SearchParams): void {
  console.log(`${hit ? 'cache hit' : 'cache miss'} ${params.kind} ${paramsHash(params)}`)
}
