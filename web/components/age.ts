/**
 * "found 12 min ago" — same rounding rule as `src/tools/cashier.ts` and
 * `src/agents/reviewer.ts`. Lives in its own module (Task 9 review, carried
 * item 3) rather than being exported from `ProposalCard.tsx`: that shape had
 * `SwapPicker` import it FROM `ProposalCard`, while `ProposalCard` itself
 * imports `SwapPicker` — a real import cycle (harmless today only because
 * both are plain function exports with no top-level side effects that
 * depend on evaluation order, which is exactly the kind of accident a future
 * refactor could turn into a real bug). A standalone module both import from
 * has no cycle to accidentally break.
 *
 * Pass 3 added the hours/days forms. Expired prices now STAY on screen
 * (web/data.ts's `loadResults` keeps them and flags them) instead of
 * vanishing on a page refresh past their ttl, so an age is no longer always
 * a number of minutes: "found 214 min ago" is arithmetic, not an answer,
 * and the stale banner needs the same words the cards under it use.
 */

/** '12 min' / '2 h' / '3 d' — one unit, never two, rounded the way a traveller would say it. */
export function ageWords(fetchedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(fetchedAt).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

export function ageText(fetchedAt: string, now: Date): string {
  return `found ${ageWords(fetchedAt, now)} ago`
}

/**
 * 'Prices from 2 h ago' — what an EXPIRED card prints in place of its age,
 * and (with a full stop, see `StaleBanner` in `ResultsPane`) the sentence
 * above the list. "found 2 h ago" is a fact about our corpus; this is a
 * warning about the number beside it.
 */
export function staleAgeText(fetchedAt: string, now: Date): string {
  return `Prices from ${ageWords(fetchedAt, now)} ago`
}
