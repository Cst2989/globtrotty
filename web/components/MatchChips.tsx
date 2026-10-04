/**
 * Hotels pass, section 7, re-cut by the trip-stage pass's section 4: ONE flowing row of small
 * chips saying how an option lines up with what she asked for.
 *
 * Every string comes from `matchesFor`/`issuesFor` (src/intake/verdicts.ts) by way of the
 * `results` row, which `ResultsContentSchema` re-checks against the same fixed vocabulary — so
 * nothing a supplier or a model wrote can appear here looking like this office's own verdict.
 *
 * Renders nothing for an empty list, which is also what an UNCHECKED item gets: the absence of a
 * chip never claims anything either way, and the list-level line is where "not checked" is said.
 */

/** Section 4's cap: four chips is one row on a card with a 200px photo, and the rest become `+N`. */
export const MAX_MATCH_CHIPS = 4

export type MatchChipsProps = {
  matches: string[]
  /** What Jev found WRONG, in the same row and in amber. */
  issues?: string[]
}

/**
 * The chips to draw, and how many were left out. Issues come first: a reason NOT to take this
 * option is worth more of a four-chip row than a reason to take it.
 *
 * Pure and exported so the render tests pin the cap without walking markup.
 */
export function chipsToShow(
  matches: string[], issues: string[] = [],
): { chips: { text: string; kind: 'match' | 'issue' }[]; overflow: number } {
  const all: { text: string; kind: 'match' | 'issue' }[] = [
    ...issues.map((text) => ({ text, kind: 'issue' as const })),
    ...matches.map((text) => ({ text, kind: 'match' as const })),
  ]
  return { chips: all.slice(0, MAX_MATCH_CHIPS), overflow: Math.max(0, all.length - MAX_MATCH_CHIPS) }
}

export function MatchChips({ matches, issues = [] }: MatchChipsProps) {
  const { chips, overflow } = chipsToShow(matches, issues)
  if (chips.length === 0) return null
  return (
    <span className="match-chips">
      {chips.map((chip) => (
        <span key={`${chip.kind}:${chip.text}`} className="match-chip" data-kind={chip.kind}>
          {/* A dot rather than a glyph: at 12px a Phosphor check is a smudge, and the colour is
              already carrying the meaning. `aria-hidden`, so a screen reader gets the words. */}
          <span className="match-chip-dot" aria-hidden="true" />
          {chip.text}
        </span>
      ))}
      {overflow > 0 ? <span className="match-chip match-chip-more">+{overflow}</span> : null}
    </span>
  )
}
