'use client'

import { useState } from 'react'
import { formatMoney, money } from '@/src/money'
import type { AlternativeLite } from '@/web/data'
import { ageText } from './age'

export type SwapPickerProps = {
  /**
   * Corpus alternatives for this item's kind, already RLS-scoped, deduped
   * and pre-filtered to unexpired ids by `web/data.ts`'s
   * `loadAlternatives`/`dropExpiredAlternatives`.
   */
  alternatives: AlternativeLite[]
  /** The item's current `sourceId`, excluded from the pick list. */
  selectedSourceId: string
  open: boolean
  /** Disables Swap/Confirm/Cancel while a request from THIS card is in flight. */
  pending: boolean
  /** For each option's "found N min ago" text; injectable for tests. */
  now: Date
  onToggle: () => void
  onPick: (sourceId: string) => void
}

/**
 * The `<select>`'s effective value, given the state and the alternatives
 * CURRENTLY in props. `choice` is `useState`, initialised once, and the
 * component stays mounted across `router.refresh()`, so a stale initial
 * value could otherwise point at an option that no longer exists (or at the
 * item's own id, which would burn a turn on a no-op swap). Deriving it on
 * every render means no frame in which value and options disagree.
 * Exported so `test/web-render.test.ts` can pin the stale case directly.
 */
export function effectiveChoice(
  choice: string, others: AlternativeLite[],
): string | undefined {
  return others.some((a) => a.sourceId === choice) ? choice : others[0]?.sourceId
}

/**
 * Spec §2's per-item "swap" control. Collapsed to a single "Swap" button
 * until opened; open, it is a `<select>` over the OTHER corpus results for
 * this slot's kind, each option showing its price and its own age, plus a
 * confirm button, which calls `onPick`. The caller (`ProposalCard`) POSTs.
 */
export function SwapPicker({ alternatives, selectedSourceId, open, pending, now, onToggle, onPick }: SwapPickerProps) {
  const others = alternatives.filter((a) => a.sourceId !== selectedSourceId)
  const [choice, setChoice] = useState(others[0]?.sourceId ?? selectedSourceId)
  const value = effectiveChoice(choice, others)

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={onToggle} disabled={pending || others.length === 0}>
        {others.length === 0 ? 'No alternatives yet' : 'Swap'}
      </button>
    )
  }

  return (
    <span className="swap-picker">
      <select
        value={value ?? ''}
        onChange={(event) => setChoice(event.target.value)}
        disabled={pending}
        aria-label="Alternative"
      >
        {others.map((a) => (
          <option key={a.sourceId} value={a.sourceId}>
            {a.name}, {formatMoney(money(BigInt(a.priceMinor), a.currency))} ({ageText(a.fetchedAt, now)})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => { if (value !== undefined) onPick(value) }}
        disabled={pending || value === undefined}
      >
        Confirm swap
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle} disabled={pending}>
        Cancel
      </button>
    </span>
  )
}
