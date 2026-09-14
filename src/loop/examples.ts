import type postgres from 'postgres'
import type { ItemRef } from '../gates/types.js'
import { fromStored } from '../notebook.js'
import { deriveScore, valueOr, MIN_OBSERVATIONS, type DerivedScore, type Observation } from './derive.js'
import { difficultyOf, type Difficulty } from './difficulty.js'
import { similarity, bookedSetsFor, type BookedSet } from './similarity.js'

/**
 * How many past itineraries go into a desk prompt. P4 says two or three, and this
 * branch says two, per segment, which is four in a prompt that has both.
 *
 * The number is small for a reason that is about tokens and not about taste:
 * the desk prompt is the cached prefix of every step of every turn, and an
 * example set that grows is a prefix that invalidates its own cache every
 * refresh.
 */
export const EXAMPLES_PER_PROMPT = 2

/** One past itinerary, with the score that chose it and the rows behind that score. */
export type Example = {
  proposalId: string
  difficulty: Difficulty
  survival: DerivedScore
  components: readonly { slot: string; sourceId: string }[]
}

type ProposalRow = {
  id: string
  refs: ItemRef[]
  refs_schema_version: number
  requirements_snapshot: unknown
}

/**
 * The best-surviving proposals of one difficulty, for one traveller.
 *
 * SEGMENTED, and the segment is an argument rather than an option: a caller
 * that wanted the unsegmented ranking would have to pass null and read the
 * docstring that says what that means, which is the shape this module wants for
 * every decision it has argued about.
 *
 * The MIN_OBSERVATIONS guard runs over the SEGMENT and not over the traveller.
 * That is the whole point of segmenting: a traveller with twenty simple
 * bookings and two complex ones has a learned ranking for the first and no
 * ranking at all for the second, and a guard applied to her total would hand
 * the complex prompt two examples chosen by noise. When the segment abstains,
 * this returns an EMPTY list, and lesson 7.2's argument is why: the honest
 * thing below the threshold is to show the desk no examples rather than bad
 * ones.
 */
export async function selectExamples(
  sql: postgres.Sql,
  args: { userId: string; difficulty: Difficulty | null; limit?: number },
): Promise<Example[]> {
  const booked: BookedSet[] = await bookedSetsFor(sql, { userId: args.userId })
  if (booked.length === 0) return []
  const rows = await sql<ProposalRow[]>`
    select id, refs, refs_schema_version, requirements_snapshot
      from course.proposals
     where user_id = ${args.userId}
       and id = any(${booked.map((b) => b.proposalId)})
       and decision = 'accept'
     order by seq`
  const scored: Example[] = []
  const observations: Observation[] = []
  for (const row of rows) {
    const difficulty = difficultyOf(
      row.requirements_snapshot === null ? null : fromStored(row.requirements_snapshot))
    if (difficulty === null) continue
    if (args.difficulty !== null && difficulty !== args.difficulty) continue
    const set = booked.find((b) => b.proposalId === row.id)!
    const survival = similarity(
      { id: row.id, refs: row.refs, refsSchemaVersion: row.refs_schema_version }, set)
    if (survival.basis === 'none') continue
    scored.push({
      proposalId: row.id,
      difficulty,
      survival,
      components: row.refs.map((r) => ({ slot: r.slot, sourceId: r.sourceId })),
    })
    observations.push({ proposalId: row.id, decidedAt: new Date(), value: survival.value })
  }
  // The guard, over the segment. `deriveScore` is asked here for its BASIS and
  // not for its value: what the ranking needs to know is whether this segment
  // has enough rows to be ranked at all, and that question has one answer in
  // one place (src/loop/derive.ts) rather than a second `>= 5` written here.
  if (deriveScore(observations).basis !== 'learned') return []
  return scored
    .sort((a, b) => valueOr(b.survival, 0) - valueOr(a.survival, 0))
    .slice(0, args.limit ?? EXAMPLES_PER_PROMPT)
}

/**
 * The examples file, as bytes, with its provenance in a comment.
 *
 * The comment is an HTML comment for a reason this branch already relies on:
 * `loadDesk` strips every `<!-- ... -->` before the prompt is assembled and
 * before it is hashed (src/desks.ts, lesson 5.4's fix round), so the provenance
 * never reaches the model, never costs an input token, and never moves
 * `prompt_version`. That last property is the one worth stating: a re-run that
 * chose the same examples on a different day writes a different comment and the
 * SAME version, which is correct, because the prompt did not change.
 *
 * Lesson 7.2's rule is that any derived number carries which rows produced it.
 * The prompt the loop wrote is the derived number this module most needs that
 * rule for, because it is the one a reader will otherwise take as a hand-written
 * instruction.
 */
export function renderExamples(
  sections: readonly { difficulty: Difficulty; examples: readonly Example[] }[],
  generatedAt: string,
): string {
  const provenance = sections.flatMap((s) => s.examples.flatMap((e) => [
    `  ${s.difficulty}: proposal ${e.proposalId} scored ${valueOr(e.survival, 0).toFixed(2)}`,
    `    from rows ${e.survival.sourceProposalIds.join(', ')}`,
  ]))
  const body = sections
    .filter((s) => s.examples.length > 0)
    .map((s) => [
      `Past trips of the ${s.difficulty} kind that she booked as proposed:`,
      ...s.examples.map((e) =>
        `- ${e.components.map((c) => `${c.slot} ${c.sourceId}`).join(', ')}`),
    ].join('\n'))
  return [
    '<!-- generated by npm run examples. Selected, not written.',
    `  generated at ${generatedAt}`,
    `  minimum observations per segment ${MIN_OBSERVATIONS}`,
    ...provenance,
    '-->',
    'Examples of trips this traveller accepted as proposed. They are examples of shape',
    'and not of price: search for her own dates and quote what the search returns.',
    '',
    ...body,
    '',
  ].join('\n')
}
