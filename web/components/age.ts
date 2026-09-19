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
 */
export function ageText(fetchedAt: string, now: Date): string {
  const ageMin = Math.max(0, Math.round((now.getTime() - new Date(fetchedAt).getTime()) / 60_000))
  return `found ${ageMin} min ago`
}
