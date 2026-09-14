import type postgres from 'postgres'
import { decidedProposals } from '../repo/proposals.js'

/**
 * How many decided proposals a segment needs before a number derived from it is
 * a measurement rather than a rumour.
 *
 * Five, chosen and written down rather than falling out of a `>` somewhere, for
 * the reason TOLERANCE_BPS is written down in src/cashier.ts: a threshold
 * nobody picked turns out to be one the day somebody runs the query on a fresh
 * traveller. Five is small on purpose. It is not a statistical claim, it is the
 * point below which one atypical trip moves the ranking more than the trend
 * does, and the honest thing to do below it is to say so rather than to
 * estimate harder.
 */
export const MIN_OBSERVATIONS = 5

/** How many recent rows the fallback looks at. Three, because it is a hint and not a ranking. */
export const RECENCY_WINDOW = 3

/** One decided proposal, reduced to the one number a ranking reads. */
export type Observation = {
  proposalId: string
  decidedAt: Date
  /** Zero to one. This lesson's number is acceptance; lesson 7.3 swaps in survival. */
  value: number
}

/**
 * A number, and the rows it came from, and what kind of number it is.
 *
 * A union rather than a record with an optional field, and the whole of the
 * lesson is in the third arm. `{ basis: 'none' }` carries NO `value`, so a
 * caller cannot read one off a score derived from nothing: `score.value ?? 0`
 * does not compile, which is P4's "an accidental fallback is usually `?? 0`"
 * turned from advice into a compiler error. Abstaining is the only thing the
 * type lets you do, and a caller that genuinely must have a number calls
 * `valueOr` below and says so at its own call site.
 *
 * `sourceProposalIds` is on every arm, including the empty one, because P4's
 * third requirement is that any similarity score, any ranking and any "users
 * prefer X" carries which rows produced it. On the `'none'` arm the answer is
 * the empty list, which is a fact and not a gap: it says we looked and there
 * was nothing.
 */
export type DerivedScore =
  | { basis: 'learned'; value: number; sourceProposalIds: readonly string[] }
  | { basis: 'recency'; value: number; sourceProposalIds: readonly string[] }
  | { basis: 'none'; sourceProposalIds: readonly [] }

/**
 * The guard, the fallback and the provenance, in one function, because they are
 * one decision.
 *
 * Above MIN_OBSERVATIONS the score is the mean and the basis is 'learned'.
 * Below it, and with at least one row, the score is the mean of the most recent
 * RECENCY_WINDOW rows and the basis is 'recency': the same arithmetic, and a
 * different claim about what it means. With no rows there is no number.
 *
 * The fallback is boring on purpose. Boring and explicit beats clever and
 * accidental, because the clever version is the one that cannot say which of
 * the three it just did.
 *
 * Sorted by `decidedAt` here rather than trusted from the caller: "recent"
 * is this function's word and a caller that handed rows in insertion order
 * would silently make the fallback mean something else.
 */
export function deriveScore(observations: readonly Observation[]): DerivedScore {
  if (observations.length === 0) return { basis: 'none', sourceProposalIds: [] }
  const mean = (rows: readonly Observation[]): number =>
    rows.reduce((sum, o) => sum + o.value, 0) / rows.length
  if (observations.length >= MIN_OBSERVATIONS) {
    return {
      basis: 'learned',
      value: mean(observations),
      sourceProposalIds: observations.map((o) => o.proposalId),
    }
  }
  const recent = [...observations]
    .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())
    .slice(0, RECENCY_WINDOW)
  return {
    basis: 'recency',
    value: mean(recent),
    sourceProposalIds: recent.map((o) => o.proposalId),
  }
}

/**
 * The one door out of the union for a caller that must have a number.
 *
 * Named so the decision is visible at the call site: `valueOr(score, 0.5)` reads
 * as somebody choosing what an absent measurement means, and `score.value ?? 0`
 * reads as nothing at all. There is exactly one caller of this on the branch
 * today (lesson 7.4's ranking, which sorts an absent score to the middle rather
 * than to the bottom) and the lesson says why the middle: sorting it to the
 * bottom is the compounding bug this module opened on.
 */
export function valueOr(score: DerivedScore, absent: number): number {
  return score.basis === 'none' ? absent : score.value
}

/**
 * Her decided proposals as observations, newest first, where the number is
 * whether she accepted.
 *
 * Acceptance is the number this lesson can honestly derive: it is one column on
 * one table and it needs nothing that does not exist yet. Lesson 7.3 builds
 * survival, which is a better number about the same rows, and swaps it in
 * without changing anything here, because the guard and the provenance are
 * about the SHAPE of a derived number and not about which number it is.
 *
 * `decidedProposals` is module 6's read (src/repo/proposals.ts, lesson 6.6),
 * reused rather than re-queried: it already scopes by user and orders the way
 * this schema orders, and a second query against the same table for the same
 * rows is the duplicate-reader half of the duplicate-writer defect lesson 7.1
 * pinned.
 */
export async function acceptanceObservations(
  sql: postgres.Sql, args: { userId: string; limit?: number },
): Promise<Observation[]> {
  const rows = await decidedProposals(sql, { userId: args.userId, limit: args.limit })
  return rows
    .filter((p): p is typeof p & { decidedAt: Date } => p.decidedAt !== null)
    .map((p) => ({
      proposalId: p.id,
      decidedAt: p.decidedAt,
      value: p.decision === 'accept' ? 1 : 0,
    }))
}
