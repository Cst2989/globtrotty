import type { ChangeEvent } from 'react'
import { Minus, Plus } from '@phosphor-icons/react/dist/ssr'
import { formatMoney, money } from '@/src/money'
import type { Filter } from '@/src/results'
import type { ResultItemLite } from '@/web/data'
import { priceRange, airlineCounts, airlineNamesOf, isFilterSet } from '@/web/filters'

export type FilterRailProps = {
  kind: 'flights' | 'hotels'
  /** The UNFILTERED items for this section — the price range, the airline list and its counts all come from here. */
  items: ResultItemLite[]
  filter: Filter
  onChange: (filter: Filter) => void
}

/** How many of each bag the stepper will ask for. Two checked bags is past any fare's allowance. */
const MAX_BAGS = 2

/** Which stops option the current filter is on — the four are mutually exclusive by construction. */
export type StopsMode = 'any' | 'direct' | 'max1' | 'max2'

export function stopsModeOf(filter: Filter): StopsMode {
  if (filter.nonstop) return 'direct'
  if (filter.maxStops === 0) return 'direct'
  if (filter.maxStops === 1) return 'max1'
  if (filter.maxStops === 2) return 'max2'
  return 'any'
}

/**
 * The `Filter` for one stops option. `direct` writes `nonstop` rather than `maxStops: 0` because
 * that is the field a typed "only direct flights" sets (src/agents/router.ts) and
 * `describeFilter` prints the two identically — one filter, one spelling.
 */
export function withStopsMode(filter: Filter, mode: StopsMode): Filter {
  const { nonstop: _nonstop, maxStops: _maxStops, ...rest } = filter
  if (mode === 'direct') return { ...rest, nonstop: true }
  if (mode === 'max1') return { ...rest, maxStops: 1 }
  if (mode === 'max2') return { ...rest, maxStops: 2 }
  return rest
}

const STOPS_OPTIONS: { mode: StopsMode; label: string }[] = [
  { mode: 'any', label: 'Any' },
  { mode: 'direct', label: 'Direct' },
  { mode: 'max1', label: 'Up to 1 stop' },
  { mode: 'max2', label: 'Up to 2 stops' },
]

const DEPARTURE_OPTIONS: { window: 'morning' | 'afternoon' | 'evening'; label: string }[] = [
  { window: 'morning', label: 'Morning' },
  { window: 'afternoon', label: 'Afternoon' },
  { window: 'evening', label: 'Evening' },
]

const RATING_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: 3, label: '3+' },
  { value: 4, label: '4+' },
]

/** One bag stepper: minus, the count, plus. 0 means the filter is off, not "0 bags required". */
function BagStepper(
  { label, value, onSet }: { label: string; value: number; onSet: (next: number) => void },
) {
  return (
    <div className="bag-stepper">
      <span className="bag-stepper-label">{label}</span>
      <span className="bag-stepper-controls">
        <button
          type="button" className="btn btn-ghost btn-icon btn-sm"
          aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= 0}
          onClick={() => onSet(value - 1)}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <output className="bag-stepper-value">{value}</output>
        <button
          type="button" className="btn btn-ghost btn-icon btn-sm"
          aria-label={`More ${label.toLowerCase()}`} disabled={value >= MAX_BAGS}
          onClick={() => onSet(value + 1)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

/**
 * The filter rail: a column to the left of the list (above it below 1100px) holding every way to
 * narrow what is shown.
 *
 * This replaced a single wrapping row of pill chips. The chips were fine for two or three
 * filters and unreadable at eight: "Nonstop", "Up to 1 stop", three departure windows, a price
 * `<select>` and one pill per airline, all in one line-wrapping row where nothing said which
 * pills were alternatives to each other. A rail says so structurally — radios for the one
 * stops answer, steppers for a count, checkboxes for the set of airlines — and it has room for
 * each airline's NAME and how many results carry it, which the chips could never fit.
 *
 * State is lifted to `ResultsPane` exactly as the chips' was: this component only ever calls
 * `onChange` with the next `Filter` and never applies one (`applyFilterLite`'s job).
 *
 * Pure, so `test/web-results-render.test.ts` renders it directly.
 */
export function FilterRail({ kind, items, filter, onChange }: FilterRailProps) {
  const currency = items[0]?.currency ?? 'EUR'
  const { min, max } = priceRange(items)
  const counts = airlineCounts(items)
  const names = airlineNamesOf(items)
  const airlines = [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b))
  const capMinor = filter.maxPriceMinor === undefined ? max : BigInt(filter.maxPriceMinor)

  function setDeparture(window: 'morning' | 'afternoon' | 'evening') {
    const { departure, ...rest } = filter
    onChange(departure === window ? rest : { ...rest, departure: window })
  }

  function setBags(field: 'minCabinBags' | 'minCheckedBags', next: number) {
    const copy = { ...filter }
    if (next <= 0) delete copy[field]
    else copy[field] = Math.min(MAX_BAGS, next)
    onChange(copy)
  }

  function setRating(value: number | null) {
    const { minRating: _minRating, ...rest } = filter
    onChange(value === null ? rest : { ...rest, minRating: value })
  }

  function setAirline(code: string, on: boolean) {
    const current = filter.airlines ?? []
    const next = on ? [...new Set([...current, code])] : current.filter((a) => a !== code)
    const { airlines: _airlines, ...rest } = filter
    onChange(next.length > 0 ? { ...rest, airlines: next } : rest)
  }

  function setCap(event: ChangeEvent<HTMLInputElement>) {
    const value = BigInt(event.target.value)
    const { maxPriceMinor: _maxPriceMinor, ...rest } = filter
    // At the top of the range there is no cap at all, rather than a cap that happens to admit
    // everything: a stored `maxPriceMinor` would otherwise keep narrowing the list after a
    // cheaper search replaced it.
    onChange(value >= max ? rest : { ...rest, maxPriceMinor: value.toString() })
  }

  // A slider over a few hundred euros needs a step small enough to land on a real price and
  // large enough that dragging it is not a pixel hunt; fifty notches is that, and `1n` is the
  // floor for a range narrow enough that fifty notches would round to nothing.
  const step = max > min ? ((max - min) / 50n || 1n).toString() : '1'

  return (
    <aside className="filter-rail" aria-label={kind === 'hotels' ? 'Narrow the hotels' : 'Narrow the flights'}>
      <div className="filter-rail-head">
        <h3 className="filter-rail-title">Filters</h3>
        {isFilterSet(filter) ? (
          <button type="button" className="link-button" onClick={() => onChange({})}>
            Clear filters
          </button>
        ) : null}
      </div>

      {kind === 'flights' ? (
        <>
          <fieldset className="filter-group">
            <legend className="filter-group-title">Stops</legend>
            {STOPS_OPTIONS.map((option) => (
              <label key={option.mode} className="filter-radio">
                <input
                  type="radio" name="filter-rail-stops" value={option.mode}
                  checked={stopsModeOf(filter) === option.mode}
                  onChange={() => onChange(withStopsMode(filter, option.mode))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="filter-group">
            <legend className="filter-group-title">Bags</legend>
            <BagStepper
              label="Cabin bags" value={filter.minCabinBags ?? 0}
              onSet={(next) => setBags('minCabinBags', next)}
            />
            <BagStepper
              label="Checked bags" value={filter.minCheckedBags ?? 0}
              onSet={(next) => setBags('minCheckedBags', next)}
            />
          </fieldset>

          <fieldset className="filter-group">
            <legend className="filter-group-title">Departure</legend>
            <div className="filter-chip-row">
              {DEPARTURE_OPTIONS.map((option) => (
                <button
                  key={option.window} type="button" className="chip chip-sm"
                  aria-pressed={filter.departure === option.window}
                  onClick={() => setDeparture(option.window)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <fieldset className="filter-group">
          <legend className="filter-group-title">Rating</legend>
          {RATING_OPTIONS.map((option) => (
            <label key={option.label} className="filter-radio">
              <input
                type="radio" name="filter-rail-rating" value={option.label}
                checked={(filter.minRating ?? null) === option.value}
                onChange={() => setRating(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      )}

      {max > 0n ? (
        <div className="filter-group">
          <label className="filter-group-title" htmlFor={`filter-rail-price-${kind}`}>
            Max price
          </label>
          <output className="filter-price-cap" htmlFor={`filter-rail-price-${kind}`}>
            {formatMoney(money(capMinor, currency))}
          </output>
          <input
            id={`filter-rail-price-${kind}`}
            className="filter-price-slider"
            type="range"
            min={min.toString()}
            max={max.toString()}
            step={step}
            value={capMinor.toString()}
            onChange={setCap}
          />
        </div>
      ) : null}

      {kind === 'flights' && airlines.length > 0 ? (
        <fieldset className="filter-group">
          <legend className="filter-group-title">Airlines</legend>
          {airlines.map((code) => (
            <label key={code} className="filter-check">
              <input
                type="checkbox"
                checked={(filter.airlines ?? []).includes(code)}
                onChange={(event) => setAirline(code, event.target.checked)}
              />
              <span className="filter-check-name">{names.get(code) ?? code}</span>
              <span className="filter-check-count">{counts.get(code)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </aside>
  )
}
