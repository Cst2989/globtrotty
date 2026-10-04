import { formatMoneyShort, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
import { leadersBySort, type Sort } from '@/web/filters'
import { durationWords } from './FlightCard'

export type SortTabsProps = {
  /** The FILTERED items — each tab summarises what it would actually put on top right now. */
  items: ResultItemLite[]
  /** Which sorts to offer, in order. Flights get all three; a hotel list has no "fastest". */
  sorts: Sort[]
  active: Sort
  /**
   * Pass 3: this list's prices are being re-run, so each tab's summary is a shimmer rather than a
   * figure. A tab cannot go on advertising "€845.00 · 14h 15m" while every card under it has
   * hidden its own price — that is the row claiming to know something the list has just said it
   * does not.
   */
  updating?: boolean
  onChange: (sort: Sort) => void
}

const LABELS: Record<Sort, string> = {
  best: 'Best',
  cheapest: 'Cheapest',
  fastest: 'Fastest',
  rated: 'Top rated',
}

/**
 * `€2,657 · 44h 20m` for a flight, `€1,120.00 · 4.4` for a stay — the price of whatever this sort
 * would put first, and the one other figure that tab is about, so the tabs are a comparison and
 * not just three ways to reorder the same list.
 */
export function tabSummary(item: ResultItemLite | null): string {
  if (!item) return '—'
  const price = formatMoneyShort(money(BigInt(item.priceMinor), item.currency))
  const flight = item.flight
  if (flight) return `${price} · ${durationWords(flight.durationMinutes)}`
  // A stay's second half is its rating, which is what the hotels pass's Top rated tab is sorting
  // on: a row of three identical prices says nothing about which tab to press.
  const rating = item.hotel?.rating ?? null
  return rating === null ? price : `${price} · ${rating.toFixed(1)}`
}

/**
 * Best / Cheapest / Fastest above the list, each showing what it leads with.
 *
 * `Best` is the order the `results` row stores, which is Jev's own re-rank against the brief
 * (src/intake/rank.ts) — the only one of the three that knows anything about the trip — so it is
 * the default and it reorders nothing.
 *
 * `role="tablist"` with no `tabpanel` is deliberate: these do not switch panels, they reorder the
 * one list below, and `aria-pressed` buttons in a group is the honest markup for that.
 *
 * Pure. `test/web-results-render.test.ts` renders it directly.
 */
export function SortTabs({ items, sorts, active, updating = false, onChange }: SortTabsProps) {
  const leaders = leadersBySort(items, sorts)

  return (
    <div className="sort-tabs" role="group" aria-label="Sort the results">
      {sorts.map((sort) => (
        <button
          key={sort}
          type="button"
          className="sort-tab"
          aria-pressed={sort === active}
          onClick={() => onChange(sort)}
        >
          <span className="sort-tab-label">{LABELS[sort]}</span>
          {updating ? (
            <span className="skeleton-line sort-tab-skeleton" aria-label="Updating the prices" />
          ) : (
            <span className="sort-tab-summary">{tabSummary(leaders.get(sort) ?? null)}</span>
          )}
        </button>
      ))}
    </div>
  )
}
