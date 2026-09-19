'use client'

import { useState } from 'react'
import { formatMoney, money } from '@/src/money'
import type { AlternativeLite } from '@/web/data'

export type SwapPickerProps = {
  /** Corpus alternatives for this item's kind, already RLS-scoped and deduped by `web/data.ts`'s `loadAlternatives`. */
  alternatives: AlternativeLite[]
  /** The item's current `sourceId` — excluded from the pick list; swapping it for itself is not an option. */
  selectedSourceId: string
  open: boolean
  onToggle: () => void
  onPick: (sourceId: string) => void
}

/**
 * Spec §2's per-item "swap" control. Collapsed to a single "Swap" button
 * until opened; open, it is a `<select>` over the OTHER corpus results for
 * this slot's kind plus a confirm button, which calls `onPick` — the caller
 * (`ProposalCard`) is the one that POSTs to `/api/proposals/[id]/revise`,
 * this component only ever reads props and reports a choice back up.
 */
export function SwapPicker({ alternatives, selectedSourceId, open, onToggle, onPick }: SwapPickerProps) {
  const others = alternatives.filter((a) => a.sourceId !== selectedSourceId)
  const [choice, setChoice] = useState(others[0]?.sourceId ?? selectedSourceId)

  if (!open) {
    return (
      <button type="button" onClick={onToggle} disabled={others.length === 0}>
        Swap
      </button>
    )
  }

  return (
    <span className="swap-picker">
      <select value={choice} onChange={(event) => setChoice(event.target.value)}>
        {others.map((a) => (
          <option key={a.sourceId} value={a.sourceId}>
            {a.name} — {formatMoney(money(BigInt(a.priceMinor), a.currency))}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => onPick(choice)} disabled={others.length === 0}>
        Confirm swap
      </button>
      <button type="button" onClick={onToggle}>
        Cancel
      </button>
    </span>
  )
}
