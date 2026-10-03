import { formatMoney, money } from '@/src/money'
import type { ResultItemLite } from '@/web/data'
import { ageText } from './age'

export type HotelListProps = {
  items: ResultItemLite[]
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders pinned, with no button. */
  chosenSourceId?: string | null
  onChoose: (sourceId: string) => void
}

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
export function HotelList({ items, now, chosenSourceId, onChoose }: HotelListProps) {
  const clock = now ?? new Date()
  return (
    <ul className="hotel-list">
      {items.map((item) => {
        const hotel = item.hotel
        if (!hotel) return null
        const chosen = chosenSourceId != null && item.sourceId === chosenSourceId
        return (
          <li key={item.sourceId} className="result-row" data-chosen={chosen}>
            <div className="result-row-main">
              <span className="result-row-name">{item.name}</span>
              <span className="result-row-meta">
                {ratingStars(hotel.rating)} · {hotel.nights} {hotel.nights === 1 ? 'night' : 'nights'} ·{' '}
                {hotel.checkIn} {'→'} {hotel.checkOut}
              </span>
              <span className="result-row-age">{ageText(item.fetchedAt, clock)}</span>
            </div>
            <div className="result-row-side">
              <span className="result-row-price">{formatMoney(money(BigInt(item.priceMinor), item.currency))}</span>
              {chosen ? (
                <span className="result-row-chosen">Chosen</span>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onChoose(item.sourceId)}>
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
