import type { ChangeEvent } from 'react'
import { formatMoney, money } from '@/src/money'
import type { Filter } from '@/src/results'
import type { ResultItemLite } from '@/web/data'
import { priceSteps, priceRange } from '@/web/filters'

export type FilterChipsProps = {
  /** The unfiltered items for this section — used to compute the price steps and the airline list. */
  items: ResultItemLite[]
  filter: Filter
  onChange: (filter: Filter) => void
}

/**
 * Spec §2.2's filter chips: nonstop / up to 1 stop (mutually exclusive),
 * departure window (single-select), a price cap `<select>`, and one chip per
 * airline seen in `items`. State is lifted to the caller (`ResultsPane`) —
 * this component only ever calls `onChange` with the next `Filter`, it never
 * applies one itself (that is `applyFilterLite`'s job, in `web/filters.ts`).
 * Pure, so `test/web-results-render.test.ts` can render it directly.
 */
export function FilterChips({ items, filter, onChange }: FilterChipsProps) {
  const currency = items[0]?.currency ?? 'EUR'
  const { min, max } = priceRange(items)
  const steps = priceSteps(min, max)
  const airlines = [...new Set(items.flatMap((i) => i.flight?.airlines ?? []))].sort()

  const stopsMode: 'nonstop' | 'max1' | null = filter.nonstop ? 'nonstop' : filter.maxStops === 1 ? 'max1' : null

  function withoutStops(f: Filter): Filter {
    const { nonstop, maxStops, ...rest } = f
    return rest
  }

  function toggleStops(mode: 'nonstop' | 'max1') {
    const rest = withoutStops(filter)
    if (stopsMode === mode) {
      onChange(rest)
      return
    }
    onChange(mode === 'nonstop' ? { ...rest, nonstop: true } : { ...rest, maxStops: 1 })
  }

  function toggleDeparture(window: 'morning' | 'afternoon' | 'evening') {
    const { departure, ...rest } = filter
    onChange(departure === window ? rest : { ...rest, departure: window })
  }

  function toggleAirline(code: string) {
    const current = filter.airlines ?? []
    const next = current.includes(code) ? current.filter((a) => a !== code) : [...current, code]
    const { airlines: _airlines, ...rest } = filter
    onChange(next.length > 0 ? { ...rest, airlines: next } : rest)
  }

  function onPriceCap(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value
    const { maxPriceMinor: _maxPriceMinor, ...rest } = filter
    onChange(value ? { ...rest, maxPriceMinor: value } : rest)
  }

  return (
    <div className="filter-chips" role="group" aria-label="Filters">
      <button type="button" className="chip" aria-pressed={stopsMode === 'nonstop'} onClick={() => toggleStops('nonstop')}>
        Nonstop
      </button>
      <button type="button" className="chip" aria-pressed={stopsMode === 'max1'} onClick={() => toggleStops('max1')}>
        Up to 1 stop
      </button>
      <button
        type="button" className="chip" aria-pressed={filter.departure === 'morning'}
        onClick={() => toggleDeparture('morning')}
      >
        Morning
      </button>
      <button
        type="button" className="chip" aria-pressed={filter.departure === 'afternoon'}
        onClick={() => toggleDeparture('afternoon')}
      >
        Afternoon
      </button>
      <button
        type="button" className="chip" aria-pressed={filter.departure === 'evening'}
        onClick={() => toggleDeparture('evening')}
      >
        Evening
      </button>
      {steps.length > 0 ? (
        <label className="chip-select">
          <span className="visually-hidden">Maximum price</span>
          <select value={filter.maxPriceMinor ?? ''} onChange={onPriceCap}>
            <option value="">Any price</option>
            {steps.map((s) => (
              <option key={s} value={s}>
                {formatMoney(money(BigInt(s), currency))} or less
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {airlines.map((code) => (
        <button
          key={code} type="button" className="chip"
          aria-pressed={(filter.airlines ?? []).includes(code)}
          onClick={() => toggleAirline(code)}
        >
          {code}
        </button>
      ))}
    </div>
  )
}
