'use client'

import { useRef } from 'react'
import { formatMoney, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
import { ageText, staleAgeText } from './age'
import { useListFlip } from './flip'

export type HotelListProps = {
  items: ResultItemLite[]
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders pinned, with no button. */
  chosenSourceId?: string | null
  /** Pass 3, section 6a: a choice is in flight, so no OTHER row's Choose is an offer any more. */
  selectDisabled?: boolean
  /** Pass 3: a refresh of this list's own search is in flight — see `FlightCardProps.updating`. */
  updating?: boolean
  onChoose: (sourceId: string) => void
}

/** Pass 3: same treatment as `FlightCard`'s own price and Select — see that file. */
const UPDATING = 'Updating prices'
const STALE = 'These prices are out of date'

/** "★★★★" for a 4-star rating, "Unrated" when the corpus carries none. */
export function ratingStars(rating: number | null): string {
  if (rating === null) return 'Unrated'
  const whole = Math.max(0, Math.min(5, Math.round(rating)))
  return '★'.repeat(whole)
}

/**
 * Spec §2.4's hotel list: name, rating as stars text, nights and dates,
 * price, fetched age, a `Choose` button — same pinned/`Chosen` convention as
 * `FlightList`. Pure (`onChoose` is a callback prop).
 */
export function HotelList(
  { items, now, chosenSourceId, selectDisabled = false, updating = false, onChoose }: HotelListProps,
) {
  const clock = now ?? new Date()
  const listRef = useRef<HTMLUListElement>(null)
  // Pass 3: same FLIP as `FlightList` — see `useListFlip`.
  useListFlip(listRef, items.map((i) => i.sourceId).join(','))

  return (
    <ul className="hotel-list" ref={listRef}>
      {items.map((item) => {
        const hotel = item.hotel
        if (!hotel) return null
        const chosen = chosenSourceId != null && item.sourceId === chosenSourceId
        return (
          <li
            key={item.sourceId}
            className="result-row"
            data-chosen={chosen}
            data-expired={item.expired && !updating ? 'true' : undefined}
            data-flip-id={item.sourceId}
            style={{ viewTransitionName: `card-${item.sourceId.replace(/[^A-Za-z0-9]/g, '-')}` }}
          >
            <div className="result-row-main">
              <span className="result-row-name">{item.name}</span>
              <span className="result-row-meta">
                {ratingStars(hotel.rating)} · {hotel.nights} {hotel.nights === 1 ? 'night' : 'nights'} ·{' '}
                {hotel.checkIn} {'→'} {hotel.checkOut}
              </span>
              <span className="result-row-age">
                {updating ? UPDATING : (item.expired ? staleAgeText(item.fetchedAt, clock) : ageText(item.fetchedAt, clock))}
              </span>
            </div>
            <div className="result-row-side">
              {updating ? (
                <span className="skeleton-line skeleton-line-price" aria-label="Updating the price" />
              ) : (
                <span className="result-row-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
              )}
              {chosen ? (
                <span className="result-row-chosen">Chosen</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={item.expired || selectDisabled}
                  title={updating ? UPDATING : (item.expired ? STALE : undefined)}
                  onClick={() => onChoose(item.sourceId)}
                >
                  Choose
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
