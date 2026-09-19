'use client'

import { useState } from 'react'
import { formatMoney, money } from '@/src/money'
import type { AlternativeLite } from '@/web/data'
import { ageText } from './ProposalCard'

export type SwapPickerProps = {
  /**
   * Corpus alternatives for this item's kind, already RLS-scoped, deduped
   * and — Task 8 review, Minor #4 — pre-filtered to unexpired ids by
   * `web/data.ts`'s `loadAlternatives`/`dropExpiredAlternatives`.
   */
  alternatives: AlternativeLite[]
  /** The item's current `sourceId` — excluded from the pick list; swapping it for itself is not an option. */
  selectedSourceId: string
  open: boolean
  /** Disables Swap/Confirm/Cancel while a request from THIS card is in flight (Task 8 review, Minor #6). */
  pending: boolean
  /** For each option's "found N min ago" text; injectable for tests, same as `ProposalCard`'s own `now`. */
  now: Date
  onToggle: () => void
  onPick: (sourceId: string) => void
}

/**
 * Spec §2's per-item "swap" control. Collapsed to a single "Swap" button
 * until opened; open, it is a `<select>` over the OTHER corpus results for
 * this slot's kind — each option showing its price AND its own age, via
 * `ProposalCard`'s exported `ageText` — plus a confirm button, which calls
 * `onPick`. The caller (`ProposalCard`) is the one that POSTs to
 * `/api/proposals/[id]/revise`; this component only ever reads props and
 * reports a choice back up.
 */
export function SwapPicker({ alternatives, selectedSourceId, open, pending, now, onToggle, onPick }: SwapPickerProps) {
  const others = alternatives.filter((a) => a.sourceId !== selectedSourceId)
  const [choice, setChoice] = useState(others[0]?.sourceId ?? selectedSourceId)

  if (!open) {
    return (
      <button type="button" onClick={onToggle} disabled={pending || others.length === 0}>
        Swap
      </button>
    )
  }

  return (
    <span className="swap-picker">
      <select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={pending}>
        {others.map((a) => (
          <option key={a.sourceId} value={a.sourceId}>
            {a.name} — {formatMoney(money(BigInt(a.priceMinor), a.currency))} ({ageText(a.fetchedAt, now)})
          </option>
        ))}
      </select>
      <button type="button" onClick={() => onPick(choice)} disabled={pending || others.length === 0}>
        Confirm swap
      </button>
      <button type="button" onClick={onToggle} disabled={pending}>
        Cancel
      </button>
    </span>
  )
}
