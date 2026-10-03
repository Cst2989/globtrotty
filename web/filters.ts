import type { Filter } from '@/src/results'
import type { ResultItemLite } from '@/web/data'

/**
 * Client-side filter application over the lite result shape (`ResultItemLite`,
 * `web/data.ts`) — spec §2.2: "They filter client-side over the stored
 * results, no turn." Same `Filter` type (src/results.ts) a `results` row's
 * own `filter` field carries, so a filter chosen here is exactly what gets
 * written back by the typed-message `filter` intent (src/agents/filter.ts,
 * a concurrent task) when she types a change instead of clicking a chip —
 * this module does not import that one (a different task, in flight), so the
 * boundary definitions below (morning/afternoon/evening) are this module's
 * own and are documented at `inWindow` for easy reconciliation later.
 *
 * Every flight-specific field (`nonstop`, `maxStops`, `departure`,
 * `airlines`) only ever excludes a FLIGHT item (one with `.flight` set); a
 * hotel item has no leg to judge those against, so it passes through
 * unaffected. `maxPriceMinor` applies to both kinds — it compares the
 * item's own total price, not anything inside `.flight`/`.hotel`.
 */
export function applyFilterLite(items: ResultItemLite[], filter: Filter): ResultItemLite[] {
  return items.filter((item) => matchesFilter(item, filter))
}

function matchesFilter(item: ResultItemLite, filter: Filter): boolean {
  if (filter.maxPriceMinor !== undefined && BigInt(item.priceMinor) > BigInt(filter.maxPriceMinor)) {
    return false
  }

  const flight = item.flight
  if (!flight) return true // nothing else below applies to a hotel item

  if (filter.nonstop && flight.stops !== 0) return false
  if (filter.maxStops !== undefined && flight.stops > filter.maxStops) return false

  if (filter.departure) {
    const hour = departureHour(flight.outbound.departureLocal)
    if (hour === null || !inWindow(hour, filter.departure)) return false
  }

  if (filter.airlines && filter.airlines.length > 0) {
    if (!flight.airlines.some((a) => filter.airlines!.includes(a))) return false
  }

  return true
}

/**
 * Reads the hour straight off the naive ISO string (no timezone, no `Date`
 * parsing) — the same instinct `web/data.ts`'s `datesFromDetail` documents
 * for `departureLocal`: this is a naive local time, and parsing it into a
 * `Date` would silently apply whatever offset the running environment
 * happens to have. `null` when the string does not carry a recognisable
 * `T\d{2}:` hour (never thrown).
 */
function departureHour(departureLocal: string): number | null {
  const m = /T(\d{2}):/.exec(departureLocal)
  return m ? Number(m[1]) : null
}

/**
 * Boundaries this module owns (see the file doc comment above for why they
 * are not imported from elsewhere): morning 05:00–11:59, afternoon
 * 12:00–17:59, evening 18:00–04:59 (covers a late departure past midnight).
 */
function inWindow(hour: number, window: 'morning' | 'afternoon' | 'evening'): boolean {
  if (window === 'morning') return hour >= 5 && hour < 12
  if (window === 'afternoon') return hour >= 12 && hour < 18
  return hour >= 18 || hour < 5
}

/**
 * Five ascending price points between `min` and `max` (inclusive of `max`),
 * in minor units as decimal strings — `FilterChips`'s price cap `<select>`:
 * "five steps from the min to the max price in the list". Deduplicated (a
 * narrow range can otherwise repeat the same rounded step); empty when
 * there is nothing to step over (no items, or every item the same price as
 * 0).
 */
export function priceSteps(min: bigint, max: bigint): string[] {
  if (max <= 0n || max <= min) return max > 0n ? [max.toString()] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 1; i <= 5; i++) {
    const v = (min + ((max - min) * BigInt(i)) / 5n).toString()
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/** The `[min, max]` of `priceMinor` across `items`, as bigints — `{ min: 0n, max: 0n }` for an empty list. */
export function priceRange(items: ResultItemLite[]): { min: bigint; max: bigint } {
  if (items.length === 0) return { min: 0n, max: 0n }
  let min = BigInt(items[0]!.priceMinor)
  let max = min
  for (const item of items) {
    const p = BigInt(item.priceMinor)
    if (p < min) min = p
    if (p > max) max = p
  }
  return { min, max }
}
