import type postgres from 'postgres'
import type { ItemRef } from '../gates/types.js'
import { REFS_SCHEMA_VERSION, type Proposal } from '../repo/proposals.js'
import type { DerivedScore } from './derive.js'

/** A proposal we were asked to compare against a booking, in a shape we cannot compare. */
export class ShapeMismatchError extends Error {
  constructor(readonly proposalId: string, readonly expected: number, readonly found: number) {
    super(
      `Proposal ${proposalId} stores refs at schema ${found} and this comparison is written `
      + `for schema ${expected}. Refusing to score it: comparing two shapes returns a number `
      + 'rather than an error, and the number is the agency\'s best work filed as its worst.',
    )
    this.name = 'ShapeMismatchError'
  }
}

/** What she booked, for one proposal, as the supplier item ids the links carried. */
export type BookedSet = { proposalId: string; itemIds: ReadonlySet<string> }

/**
 * What a proposal she booked without changing a word must score above.
 *
 * P4's third defence: the golden trips include one case that asserts a
 * known-booked-unchanged proposal scores above 0.9. Nine tenths and not one,
 * because a component she swapped for an identical one at a different supplier
 * is a booking she did not change in any sense she would recognise, and a floor
 * of exactly 1.0 would make this assertion about our id scheme rather than
 * about her behaviour.
 */
export const GOLDEN_UNCHANGED_FLOOR = 0.9

/**
 * Defence one, and the loud half of defence four.
 *
 * Refuses rather than scores when the row's stamp is not the one this file was
 * written for, and refuses when a ref is missing a field this comparison reads.
 * The two checks are separate on purpose: the stamp catches a refactor that
 * bumped the version and forgot a reader, and the field check catches a
 * refactor that changed the shape and forgot the version, which is the one that
 * actually happens.
 */
export function assertComparableShape(
  proposal: Pick<Proposal, 'id' | 'refs' | 'refsSchemaVersion'>,
): void {
  if (proposal.refsSchemaVersion !== REFS_SCHEMA_VERSION) {
    throw new ShapeMismatchError(proposal.id, REFS_SCHEMA_VERSION, proposal.refsSchemaVersion)
  }
  const incomplete = proposal.refs.filter(
    (r: ItemRef) => typeof r?.sourceId !== 'string' || typeof r?.slot !== 'string',
  )
  if (incomplete.length > 0) {
    throw new Error(
      `Proposal ${proposal.id} carries ${incomplete.length} of ${proposal.refs.length} refs `
      + 'without a sourceId and a slot, so it was written by something other than '
      + 'recordProposal at schema 1. Refusing to score it.',
    )
  }
}

/**
 * How much of what we proposed is what she booked, and which rows say so.
 *
 * The overlap of two sets over their union, which is symmetric, and symmetry is
 * the property that matters here: "how much survived" is a question about how
 * much the two sets have in common, and a ratio over the proposal alone scores
 * a proposal of one component that she expanded into three as a perfect
 * success. A ratio over the booking alone scores a proposal of three she
 * trimmed to one the same way. The union is the only denominator that moves
 * when either side changes.
 *
 * Returns a `DerivedScore` (src/loop/derive.ts, lesson 7.2) and therefore
 * carries its source row, which is defence two: one query shows the untouched
 * proposal scoring 0.2 and somebody can ask which row that was.
 *
 * The basis is 'learned' and never 'recency', because a survival score over one
 * proposal is not a small sample of anything. It is a measurement of that
 * proposal. What lesson 7.4 guards with MIN_OBSERVATIONS is the RANKING built
 * from many of these, not each one.
 */
export function similarity(
  proposal: Pick<Proposal, 'id' | 'refs' | 'refsSchemaVersion'>, booked: BookedSet,
): DerivedScore {
  assertComparableShape(proposal)
  const proposedIds = new Set(proposal.refs.map((r) => r.sourceId))
  const union = new Set([...proposedIds, ...booked.itemIds])
  if (union.size === 0) return { basis: 'none', sourceProposalIds: [] }
  const overlap = [...proposedIds].filter((id) => booked.itemIds.has(id)).length
  return {
    basis: 'learned',
    value: overlap / union.size,
    sourceProposalIds: [proposal.id],
  }
}

/**
 * What she booked, per proposal, for one traveller.
 *
 * One query rather than a conversion read followed by a link read per proposal,
 * because the set of items behind a booking is one join and N+1 of them over a
 * traveller's history is the shape that makes a monthly refresh a nightly job.
 *
 * A proposal appears here only when a conversion was reported for it, so the
 * map's size is the denominator of every survival rate in this module, and it
 * is zero on this branch until somebody wires a feed. That is the honest number
 * and the card prints it (evals/run.ts).
 */
export async function bookedSetsFor(
  sql: postgres.Sql, args: { userId: string },
): Promise<BookedSet[]> {
  const rows = await sql<{ proposal_id: string; item_id: string }[]>`
    select lc.proposal_id, lc.item_id
      from course.conversions c
      join course.link_clicks lc on lc.id = c.link_click_id
     where c.user_id = ${args.userId}
     order by lc.seq`
  const byProposal = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byProposal.get(r.proposal_id) ?? new Set<string>()
    set.add(r.item_id)
    byProposal.set(r.proposal_id, set)
  }
  return [...byProposal].map(([proposalId, itemIds]) => ({ proposalId, itemIds }))
}

/**
 * Every proposal this traveller booked, scored, keyed by proposal id.
 *
 * A ShapeMismatchError is NOT caught here. A refactor that moved the shape is a
 * thing a person has to look at, and swallowing it into a skipped row is
 * precisely how the inversion bug ships: the number gets quieter rather than
 * louder as more rows become incomparable.
 */
export async function survivalScores(
  sql: postgres.Sql, args: { userId: string },
): Promise<Map<string, DerivedScore>> {
  const booked = await bookedSetsFor(sql, args)
  const out = new Map<string, DerivedScore>()
  for (const set of booked) {
    const rows = await sql<{ id: string; refs: ItemRef[]; refs_schema_version: number }[]>`
      select id, refs, refs_schema_version from course.proposals
       where id = ${set.proposalId} and user_id = ${args.userId}`
    const row = rows[0]
    if (!row) continue
    out.set(set.proposalId, similarity(
      { id: row.id, refs: row.refs, refsSchemaVersion: row.refs_schema_version }, set))
  }
  return out
}
