import type { ResultItemLite } from '@/web/data'
import { FlightCard } from './FlightCard'

export type FlightListProps = {
  items: ResultItemLite[]
  /** The party size the search was for — each card prints "for N passengers" under its price. */
  adults: number
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders with a `Selected` ribbon and no button. */
  chosenSourceId?: string | null
  onChoose: (sourceId: string) => void
}

/**
 * The flight results list: one `FlightCard` per item, nothing else. All of the layout moved into
 * the card (results UI pass 2, C), which is what makes the card renderable on its own in a test
 * and leaves this component with the one job a list has.
 *
 * An item with no `.flight` payload is dropped silently rather than rendered as a broken row —
 * `FlightCard` returns `null` for it — which is how a hotel item handed to this list by mistake
 * behaves.
 */
export function FlightList({ items, adults, now, chosenSourceId, onChoose }: FlightListProps) {
  return (
    <ul className="flight-list">
      {items.map((item) => (
        <FlightCard
          key={item.sourceId}
          item={item}
          adults={adults}
          now={now}
          chosen={chosenSourceId != null && item.sourceId === chosenSourceId}
          onChoose={onChoose}
        />
      ))}
    </ul>
  )
}
