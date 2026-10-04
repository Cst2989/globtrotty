import { CheckCircle } from '@phosphor-icons/react/dist/ssr'

/**
 * Hotels pass, section 7: one green check chip per FACT about this item that lines up with what
 * she asked for.
 *
 * Every string comes from `matchesFor` (src/intake/verdicts.ts) by way of the `results` row, which
 * `ResultsContentSchema` re-checks against the same fixed vocabulary — so nothing a supplier or a
 * model wrote can appear here looking like this office's own verdict.
 *
 * Renders nothing for an empty list, which is also what an UNCHECKED item gets: the absence of a
 * chip never claims anything either way, and the list-level line is where "not checked" is said.
 */
export function MatchChips({ matches }: { matches: string[] }) {
  if (matches.length === 0) return null
  return (
    <span className="match-chips">
      {matches.map((match) => (
        <span key={match} className="match-chip">
          <CheckCircle size={13} weight="fill" aria-hidden="true" />
          {match}
        </span>
      ))}
    </span>
  )
}
