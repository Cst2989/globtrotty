'use client'

import { useState } from 'react'
import { formatMoney, money } from '@/src/money'
import type { AlternativeLite } from '@/web/data'
import { ageText } from './age'

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
 * The `<select>`'s effective value, given the state and the alternatives
 * CURRENTLY in props.
 *
 * Final review, M2. `choice` is `useState`, initialised once; the component
 * stays mounted across `router.refresh()` (only its return value changes on
 * `open`), so that initial value survives new props. If the card first
 * rendered when the corpus held no alternative for this slot, `choice` was
 * seeded with `selectedSourceId` — the item's OWN id. Once a later search
 * added alternatives and the page refreshed, the Swap button enabled, the
 * `<select>` showed a value matching no `<option>`, and "Confirm swap" POSTed
 * the item's own id: a request that passes `reviseRoute`'s corpus pre-check
 * (that id is in `tool_results` for this conversation and kind) and burns a
 * whole turn — and a model call — on a no-op swap.
 *
 * Deriving it on every render, rather than resetting it in an effect, means
 * there is no frame in which the rendered value and the rendered options
 * disagree.
 *
 * Exported so `test/web-render.test.ts` can pin the stale case directly: a
 * static render always produces a consistent FIRST frame, which is precisely
 * why the bug was invisible to a render test.
 */
export function effectiveChoice(
  choice: string, others: AlternativeLite[],
): string | undefined {
  return others.some((a) => a.sourceId === choice) ? choice : others[0]?.sourceId
}

/**
 * Spec §2's per-item "swap" control. Collapsed to a single "Swap" button
 * until opened; open, it is a `<select>` over the OTHER corpus results for
 * this slot's kind — each option showing its price AND its own age, via
 * `./age`'s `ageText` (shared with `ProposalCard`, not imported from it —
 * see that module's header) — plus a confirm button, which calls
 * `onPick`. The caller (`ProposalCard`) is the one that POSTs to
 * `/api/proposals/[id]/revise`; this component only ever reads props and
 * reports a choice back up.
 */
export function SwapPicker({ alternatives, selectedSourceId, open, pending, now, onToggle, onPick }: SwapPickerProps) {
  const others = alternatives.filter((a) => a.sourceId !== selectedSourceId)
  const [choice, setChoice] = useState(others[0]?.sourceId ?? selectedSourceId)
  // Never `choice` directly — see `effectiveChoice` above.
  const value = effectiveChoice(choice, others)

  if (!open) {
    return (
      <button type="button" onClick={onToggle} disabled={pending || others.length === 0}>
        Swap
      </button>
    )
  }

  return (
    <span className="swap-picker">
      <select value={value ?? ''} onChange={(event) => setChoice(event.target.value)} disabled={pending}>
        {others.map((a) => (
          <option key={a.sourceId} value={a.sourceId}>
            {a.name} — {formatMoney(money(BigInt(a.priceMinor), a.currency))} ({ageText(a.fetchedAt, now)})
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => { if (value !== undefined) onPick(value) }}
        disabled={pending || value === undefined}
      >
        Confirm swap
      </button>
      <button type="button" onClick={onToggle} disabled={pending}>
        Cancel
      </button>
    </span>
  )
}
