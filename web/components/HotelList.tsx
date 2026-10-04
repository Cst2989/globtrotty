'use client'

import { useRef, type ReactNode } from 'react'
import type { ResultItemLite } from '@/web/data'
import { useListFlip } from './flip'
import { HotelCard } from './HotelCard'

export type HotelListProps = {
  items: ResultItemLite[]
  /** The party size the search was for — each card says what the stay price covers. */
  adults: number
  /** Injectable for tests; production passes nothing (`new Date()` each render). */
  now?: Date
  /** The source id already chosen for this slot, if any — renders pinned, with no button. */
  chosenSourceId?: string | null
  /** Pass 3, section 6a: a choice is in flight, so no OTHER row's Select is an offer any more. */
  selectDisabled?: boolean
  /** Pass 3: a refresh of this list's own search is in flight — see `FlightCardProps.updating`. */
  updating?: boolean
  /**
   * Section 7: `sourceId` -> the facts this item matched, for the green chips. Absent for a list
   * Jev never checked; an item missing from a present map is unchecked in the same way and simply
   * gets no chips.
   */
  matchesBySourceId?: Record<string, string[]>
  /** Section 5: the stay whose map pin was clicked — that card is marked while she looks at it. */
  highlightedSourceId?: string | null
  /** Hovering a card lights up its pin. */
  onHover?: (sourceId: string | null) => void
  /** Trip-stage pass, section 2: the pane's `Change` button, beside the chosen card's ribbon. */
  ribbonAction?: ReactNode
  onChoose: (sourceId: string) => void
}

/**
 * The hotels list: one `HotelCard` per stay, in the order the `results` row stores (Jev's own
 * re-rank) unless a sort tab says otherwise.
 *
 * The hotels pass replaced the flat `result-row` this used to render itself — see `HotelCard`
 * for what was wrong with it. What is left here is the list and nothing else: the FLIP
 * bookkeeping, exactly as `FlightList` does it for flights.
 */
export function HotelList(
  {
    items, adults, now, chosenSourceId, selectDisabled = false, updating = false,
    matchesBySourceId, highlightedSourceId = null, onHover, ribbonAction, onChoose,
  }: HotelListProps,
) {
  const listRef = useRef<HTMLUListElement>(null)
  // Pass 3: same FLIP as `FlightList` — see `useListFlip`.
  useListFlip(listRef, items.map((i) => i.sourceId).join(','))

  return (
    <ul className="hotel-list" ref={listRef}>
      {items.map((item) => (
        <HotelCard
          key={item.sourceId}
          item={item}
          adults={adults}
          now={now}
          chosen={chosenSourceId != null && item.sourceId === chosenSourceId}
          selectDisabled={selectDisabled}
          updating={updating}
          matches={matchesBySourceId?.[item.sourceId] ?? []}
          highlighted={highlightedSourceId === item.sourceId}
          onHover={onHover}
          ribbonAction={chosenSourceId != null && item.sourceId === chosenSourceId ? ribbonAction : undefined}
          onChoose={onChoose}
        />
      ))}
    </ul>
  )
}
