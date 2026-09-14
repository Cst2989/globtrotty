import type { Notebook } from '../notebook.js'

/**
 * How hard the trip was to plan, which is the only axis a survival score may be
 * compared along.
 *
 * Two values and not five. P4's argument needs exactly one boundary, which is
 * "was this the kind of request our scaffold was going to get right", and every
 * extra band is a band with fewer observations in it, which walks straight into
 * lesson 7.2's MIN_OBSERVATIONS guard and makes every segment abstain.
 */
export type Difficulty = 'simple' | 'complex'

/** Longer than this and the itinerary has structure a two-week search does not. */
export const COMPLEX_NIGHTS = 10

/** This many stated fields is a request with enough constraints to conflict with itself. */
export const COMPLEX_CONSTRAINTS = 4

/**
 * The rule, in words, so the lesson and the prompt file both quote one string
 * rather than two paraphrases that drift.
 */
export const DIFFICULTY_RULE =
  'A trip is complex when she travels with a child or an infant, when it needs a crib, '
  + `when it runs longer than ${COMPLEX_NIGHTS} nights, or when she stated at least `
  + `${COMPLEX_CONSTRAINTS} of the notebook's eight fields. Otherwise it is simple.`

/**
 * Read off the requirements snapshot and never off the live notebook.
 *
 * The snapshot is the notebook as it STOOD when the gates approved that
 * proposal (migration 0018), and difficulty is a property of the request we
 * answered rather than of the request as it ended up. A conversation that began
 * as a weekend and became a fortnight would otherwise re-classify every one of
 * its old proposals every time it grew, and a ranking whose buckets move under
 * it is a ranking nobody can reproduce.
 *
 * Returns null for a row written before 0018, which is a fact and not a gap:
 * `Proposal.requirementsSnapshot` is null there and an empty notebook would
 * classify every one of those rows as simple, which is the same
 * absent-reads-as-zero defect lesson 7.2 spent a whole type on.
 */
export function difficultyOf(snapshot: Notebook | null): Difficulty | null {
  if (snapshot === null) return null
  const party = snapshot.partySize?.value
  if (party && party.children + party.infants > 0) return 'complex'
  if (snapshot.needsCrib?.value === true) return 'complex'
  if ((snapshot.nights?.value ?? 0) > COMPLEX_NIGHTS) return 'complex'
  const stated = [
    snapshot.budget, snapshot.destination, snapshot.originCity, snapshot.nights,
    snapshot.month, snapshot.partySize, snapshot.nearBeach, snapshot.needsCrib,
  ].filter((field) => field !== null).length
  return stated >= COMPLEX_CONSTRAINTS ? 'complex' : 'simple'
}
