'use client'

import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { CaretDown, Minus, Plus } from '@phosphor-icons/react'
import { formatMoneyShort, money } from '@/src/money'
import type { Filter } from '@/src/results'
import type { ResultItemLite } from '@/web/data'
import { priceRange, airlineCounts, airlineNamesOf, isFilterSet } from '@/web/filters'
import { FILTER_AMENITY_KEYS, amenityLabel } from '@/src/intake/amenities'

export type FilterBarProps = {
  kind: 'flights' | 'hotels'
  /** The UNFILTERED items for this section — the price range, the airline list and its counts all come from here. */
  items: ResultItemLite[]
  filter: Filter
  onChange: (filter: Filter) => void
  /**
   * Which popover is open on the first render. `null` (the default) is what production always
   * passes; `test/web-results-render.test.ts` and the pass-3 preview use it to render an open
   * panel without a click, which is the only way a static render can see one.
   */
  openPopover?: PopoverKey | null
}

export type PopoverKey = 'bags' | 'price' | 'airlines' | 'stars' | 'amenities'

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
  { mode: 'max1', label: '1 stop' },
  { mode: 'max2', label: '2 stops' },
]

const DEPARTURE_OPTIONS: { window: 'morning' | 'afternoon' | 'evening'; label: string }[] = [
  { window: 'morning', label: 'Morning' },
  { window: 'afternoon', label: 'Afternoon' },
  { window: 'evening', label: 'Evening' },
]

/**
 * Hotels pass, section 4: 4+ and 4.5+ rather than 3+ and 4+. Three-point-something is most of a
 * hotel list, so a 3+ filter narrows almost nothing; the two bands that actually divide a list
 * are the ones a rating chip already calls "Very good" and "Excellent" (see `ratingWord`).
 */
const RATING_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: 4, label: '4+' },
  { value: 4.5, label: '4.5+' },
]

const TYPE_OPTIONS: { value: 'hotel' | 'rental' | null; label: string }[] = [
  { value: null, label: 'Any' },
  { value: 'hotel', label: 'Hotels' },
  { value: 'rental', label: 'Rentals' },
]

/** The classes worth offering: 1- and 2-star exist but nobody narrows a list to them. */
const STAR_OPTIONS = [3, 4, 5]

/**
 * 'Bags' / 'Bags: 1 cabin' / 'Bags: 1 cabin, 2 checked' — the trigger's own label says what is
 * set inside it, because a closed popover that looks identical set and unset is a filter she has
 * no way to notice she left on. Pure, so the label is pinned directly in the render tests.
 */
export function bagsLabel(filter: Filter): string {
  const parts: string[] = []
  if (filter.minCabinBags) parts.push(`${filter.minCabinBags} cabin`)
  if (filter.minCheckedBags) parts.push(`${filter.minCheckedBags} checked`)
  return parts.length === 0 ? 'Bags' : `Bags: ${parts.join(', ')}`
}

/** 'Max price' / 'Up to €845.00' — same reasoning as `bagsLabel`. */
export function priceLabel(filter: Filter, currency: string): string {
  if (filter.maxPriceMinor === undefined) return 'Max price'
  return `Up to ${formatMoneyShort(money(BigInt(filter.maxPriceMinor), currency))}`
}

/** 'Airlines' / 'Airlines (2)' — same reasoning as `bagsLabel`. */
export function airlinesLabel(filter: Filter): string {
  const n = filter.airlines?.length ?? 0
  return n === 0 ? 'Airlines' : `Airlines (${n})`
}

/** 'Stars' / 'Stars: 4, 5' — same reasoning as `bagsLabel`. */
export function starsLabel(filter: Filter): string {
  const stars = filter.stars ?? []
  return stars.length === 0 ? 'Stars' : `Stars: ${[...stars].sort((a, b) => a - b).join(', ')}`
}

/** 'Amenities' / 'Amenities (2)' — same reasoning as `bagsLabel`. */
export function amenitiesLabel(filter: Filter): string {
  const n = filter.amenities?.length ?? 0
  return n === 0 ? 'Amenities' : `Amenities (${n})`
}

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
 * A segmented control: one answer out of a short, mutually exclusive set, as touching buttons.
 * `aria-pressed` buttons in a named group is the honest markup — these do not switch panels and
 * they are not links, the same reasoning `SortTabs` records for its own row.
 */
function Segmented<T>(
  { label, options, active, onPick }: {
    label: string
    options: { value: T; label: string }[]
    active: T
    onPick: (value: T) => void
  },
) {
  return (
    <div className="filter-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className="filter-segment"
          aria-pressed={option.value === active}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A trigger button and the panel it opens. Plain DOM and one piece of local state rather than
 * `<details>`/`<summary>`: a `<details>` cannot be closed by a click somewhere else on the page
 * or by Escape without the same two listeners, and it brings a disclosure-triangle default and a
 * `<summary>` role that has to be argued with.
 *
 * `open` is local to each popover, so two can be open at once. That is deliberate: they are
 * independent filters, and forcing one closed because she opened another would lose a stepper
 * she was halfway through.
 */
function Popover(
  { label, active, defaultOpen = false, children }: {
    label: string
    /** Draws the trigger as set — the label already says what, this says "look here". */
    active: boolean
    defaultOpen?: boolean
    children: ReactNode
  },
) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="filter-pop" ref={ref}>
      <button
        type="button"
        className="filter-pop-trigger"
        data-set={active ? 'true' : 'false'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <CaretDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="filter-pop-panel" id={panelId}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The filter bar: one horizontal row directly under the summary bar and above the sort tabs,
 * holding every way to narrow what is shown.
 *
 * Pass 3, section 3 replaced the 240px left RAIL this grew out of. The rail was right about one
 * thing — a wrapping row of eight undifferentiated pills said nothing about which controls were
 * alternatives to each other — and wrong about where it put them: it took a quarter of the
 * results pane permanently, pushed the cards into a column too narrow to compare times in, and
 * sat a full screen's worth of controls beside a list she mostly wants to read. A bar keeps the
 * structure (a segmented control for the one stops answer, steppers for a count, a checklist for
 * a set of airlines) and gives the width back: the controls she uses occasionally live behind
 * three triggers that say what is set inside them, and the two she uses constantly — stops and
 * departure time — stay on the surface.
 *
 * State is lifted to `ResultsPane` exactly as the rail's was: this component only ever calls
 * `onChange` with the next `Filter` and never applies one (`applyFilterLite`'s job). The only
 * local state is which popovers are open, which is nobody else's business.
 */
export function FilterBar({ kind, items, filter, onChange, openPopover = null }: FilterBarProps) {
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

  function setPropertyType(value: 'hotel' | 'rental' | null) {
    const { propertyType: _propertyType, ...rest } = filter
    onChange(value === null ? rest : { ...rest, propertyType: value })
  }

  function setStar(star: number, on: boolean) {
    const current = filter.stars ?? []
    const next = on ? [...new Set([...current, star])].sort((a, b) => a - b) : current.filter((s) => s !== star)
    const { stars: _stars, ...rest } = filter
    onChange(next.length > 0 ? { ...rest, stars: next } : rest)
  }

  function setAmenity(key: string, on: boolean) {
    const current = filter.amenities ?? []
    const next = on ? [...new Set([...current, key])] : current.filter((a) => a !== key)
    const { amenities: _amenities, ...rest } = filter
    onChange(next.length > 0 ? { ...rest, amenities: next } : rest)
  }

  function setNearCentre(on: boolean) {
    const { nearCentre: _nearCentre, ...rest } = filter
    onChange(on ? { ...rest, nearCentre: true } : rest)
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
    <div className="filter-bar" aria-label={kind === 'hotels' ? 'Narrow the hotels' : 'Narrow the flights'}>
      {kind === 'flights' ? (
        <>
          <Segmented
            label="Stops"
            options={STOPS_OPTIONS.map((o) => ({ value: o.mode, label: o.label }))}
            active={stopsModeOf(filter)}
            onPick={(mode) => onChange(withStopsMode(filter, mode))}
          />

          <Popover
            label={bagsLabel(filter)}
            active={filter.minCabinBags !== undefined || filter.minCheckedBags !== undefined}
            defaultOpen={openPopover === 'bags'}
          >
            <BagStepper
              label="Cabin bags" value={filter.minCabinBags ?? 0}
              onSet={(next) => setBags('minCabinBags', next)}
            />
            <BagStepper
              label="Checked bags" value={filter.minCheckedBags ?? 0}
              onSet={(next) => setBags('minCheckedBags', next)}
            />
          </Popover>

          <div className="filter-chip-row" role="group" aria-label="Departure">
            {DEPARTURE_OPTIONS.map((option) => (
              <button
                key={option.window} type="button" className="chip"
                aria-pressed={filter.departure === option.window}
                onClick={() => setDeparture(option.window)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Hotels pass, section 4. Rating and Type stay on the surface (one answer each, used
              constantly); stars and amenities live behind triggers that say what is set inside
              them, exactly as the flight side's bags and airlines do. */}
          <Segmented
            label="Rating"
            options={RATING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            active={filter.minRating ?? null}
            onPick={setRating}
          />

          <Segmented
            label="Type"
            options={TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            active={filter.propertyType ?? null}
            onPick={setPropertyType}
          />

          <Popover
            label={starsLabel(filter)}
            active={(filter.stars?.length ?? 0) > 0}
            defaultOpen={openPopover === 'stars'}
          >
            <fieldset className="filter-pop-list">
              <legend className="filter-pop-title">Stars</legend>
              {STAR_OPTIONS.map((star) => (
                <label key={star} className="filter-check">
                  <input
                    type="checkbox"
                    checked={(filter.stars ?? []).includes(star)}
                    onChange={(event) => setStar(star, event.target.checked)}
                  />
                  <span className="filter-check-name">{star} star</span>
                </label>
              ))}
            </fieldset>
          </Popover>

          <Popover
            label={amenitiesLabel(filter)}
            active={(filter.amenities?.length ?? 0) > 0}
            defaultOpen={openPopover === 'amenities'}
          >
            <fieldset className="filter-pop-list">
              <legend className="filter-pop-title">Amenities</legend>
              {FILTER_AMENITY_KEYS.map((key) => (
                <label key={key} className="filter-check">
                  <input
                    type="checkbox"
                    checked={(filter.amenities ?? []).includes(key)}
                    onChange={(event) => setAmenity(key, event.target.checked)}
                  />
                  <span className="filter-check-name">{amenityLabel(key)}</span>
                </label>
              ))}
            </fieldset>
          </Popover>

          <div className="filter-chip-row" role="group" aria-label="Distance">
            <button
              type="button" className="chip"
              aria-pressed={filter.nearCentre === true}
              onClick={() => setNearCentre(filter.nearCentre !== true)}
            >
              Near the centre
            </button>
          </div>
        </>
      )}


      {max > 0n ? (
        <Popover
          label={priceLabel(filter, currency)}
          active={filter.maxPriceMinor !== undefined}
          defaultOpen={openPopover === 'price'}
        >
          <label className="filter-pop-title" htmlFor={`filter-bar-price-${kind}`}>Max price</label>
          <output className="filter-price-cap" htmlFor={`filter-bar-price-${kind}`}>
            {formatMoneyShort(money(capMinor, currency))}
          </output>
          <input
            id={`filter-bar-price-${kind}`}
            className="filter-price-slider"
            type="range"
            min={min.toString()}
            max={max.toString()}
            step={step}
            value={capMinor.toString()}
            onChange={setCap}
          />
        </Popover>
      ) : null}

      {kind === 'flights' && airlines.length > 0 ? (
        <Popover
          label={airlinesLabel(filter)}
          active={(filter.airlines?.length ?? 0) > 0}
          defaultOpen={openPopover === 'airlines'}
        >
          <fieldset className="filter-pop-list">
            <legend className="filter-pop-title">Airlines</legend>
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
        </Popover>
      ) : null}

      {isFilterSet(filter) ? (
        <button type="button" className="link-button filter-clear" onClick={() => onChange({})}>
          Clear
        </button>
      ) : null}
    </div>
  )
}
