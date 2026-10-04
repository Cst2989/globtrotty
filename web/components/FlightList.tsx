'use client'

import { useRef } from 'react'
import type { ResultItemLite } from '@/web/data'
import { FlightCard } from './FlightCard'
import { useListFlip } from './flip'

export type FlightListProps = {
  items: ResultItemLite[]
  /** The party size the search was for — each card prints "for N passengers" under its price. */
  adults: number
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders with a `Selected` ribbon and no button. */
  chosenSourceId?: string | null
  /** Pass 3, section 6a: a choice is in flight, so no OTHER card's Select is an offer any more. */
  selectDisabled?: boolean
  /** Pass 3: a refresh of this list's own search is in flight — see `FlightCardProps.updating`. */
  updating?: boolean
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
 *
 * Pass 3: `useListFlip` animates the cards to their new places when a background price refresh
 * brings back a row in a new order (Jev re-ranks every search). It is a layout measurement and
 * nothing else — no state, no render output — so this component stays as renderable under
 * `renderToStaticMarkup` as it was.
 */
export function FlightList(
  { items, adults, now, chosenSourceId, selectDisabled, updating, onChoose }: FlightListProps,
) {
  const listRef = useRef<HTMLUListElement>(null)
  useListFlip(listRef, items.map((i) => i.sourceId).join(','))

  return (
    <ul className="flight-list" ref={listRef}>
      {items.map((item) => (
        <FlightCard
          key={item.sourceId}
          item={item}
          adults={adults}
          now={now}
          chosen={chosenSourceId != null && item.sourceId === chosenSourceId}
          selectDisabled={selectDisabled}
          updating={updating}
          onChoose={onChoose}
        />
      ))}
    </ul>
  )
}
