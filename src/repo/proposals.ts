import type postgres from 'postgres'
import type { ItemRef } from '../gates/types.js'
import { fromStored, toStored, type Notebook } from '../notebook.js'

export type Proposal = {
  id: string
  conversationId: string
  userId: string
  turnId: string | null
  refs: ItemRef[]
  /**
   * The notebook as it stood when the gates approved this, or null on a row
   * written before migration 0018. Null is not an empty notebook and must never
   * be read as one: an empty notebook has no budget, so every budget gate
   * replayed against it PASSES, which is the exact failure the column exists to
   * remove. `replayGates` (src/evals/replay.ts) refuses a null rather than
   * falling back to the live notebook.
   */
  requirementsSnapshot: Notebook | null
  decision: 'accept' | 'reject' | null
  decidedAt: Date | null
}

type Row = {
  id: string; conversation_id: string; user_id: string; turn_id: string | null
  refs: ItemRef[]; requirements_snapshot: unknown
  decision: 'accept' | 'reject' | null; decided_at: Date | null
}

/**
 * Writes what the gates approved, and returns its id so the model can refer to
 * it. The refs stored are the ones `ProposalRefsSchema` validated, never the
 * raw object the model sent: the row is the server's record of what it
 * approved, and a row built from unvalidated input would be a record of what it
 * was asked to approve.
 *
 * `requirementsSnapshot` is required and has no default. A default would be how
 * one call site silently keeps writing rows a replay cannot use, and this is
 * the one write where a missing value is invisible until months later, when an
 * eval reports a green suite over proposals nobody can re-judge.
 *
 * It is a `Notebook` and not the stored jsonb, so there is ONE door into this
 * column and `toStored` is behind it. A parameter typed loosely enough to take
 * the jsonb would also take the raw notebook, and a raw notebook reaching
 * `sql.json` throws on `Money.minor`'s bigint at runtime, in the one write this
 * docstring just said must not fail quietly. Taking the notebook and
 * serialising here makes the wrong call impossible to write rather than
 * expensive to debug.
 */
export async function recordProposal(
  sql: postgres.Sql,
  args: {
    conversationId: string; userId: string; turnId: string | null
    refs: ItemRef[]; requirementsSnapshot: Notebook
  },
): Promise<string> {
  const [row] = await sql<{ id: string; requirements_snapshot: unknown }[]>`
    insert into course.proposals
      (conversation_id, user_id, turn_id, refs, requirements_snapshot)
    values (${args.conversationId}, ${args.userId}, ${args.turnId},
            ${sql.json(args.refs as never)},
            ${sql.json(toStored(args.requirementsSnapshot) as never)})
    returning id, requirements_snapshot`
  if (!row) throw new Error('recordProposal: insert returned no row')
  // The returning clause is read, not decorative. The column is nullable
  // because every pre-0018 row has a null in it, so a null written by THIS
  // function would be a proposal no replay can use, produced by the one writer
  // whose whole job is to make that impossible. Verified through `returning`
  // like every writer in this directory.
  if (row.requirements_snapshot === null) {
    throw new Error(`recordProposal: wrote proposal ${row.id} with no requirements snapshot`)
  }
  return row.id
}

/**
 * Records her answer, once. Scoped by conversation as well as by id, like every
 * read of this table, so a proposal id leaked into another conversation cannot
 * be decided from there.
 *
 * `decision is null` in the WHERE is what makes it once rather than last one
 * wins: a second answer is refused rather than overwriting the first. Verifies
 * its own effect and throws on a miss, like every writer in this directory,
 * because a silently ignored acceptance is an acceptance she believes happened.
 *
 * `at` is injectable for the same reason `now` is injectable in the gates: the
 * cashier ages this timestamp against a thirty-minute window and a test must be
 * able to walk past it without sleeping.
 */
export async function decideProposal(
  sql: postgres.Sql,
  args: { proposalId: string; conversationId: string; decision: 'accept' | 'reject'; at?: Date },
): Promise<void> {
  const rows = await sql`
    update course.proposals
       set decision = ${args.decision}, decided_at = ${args.at ?? new Date()}
     where id = ${args.proposalId} and conversation_id = ${args.conversationId}
       and decision is null
    returning id`
  if (rows.length === 0) {
    throw new Error(
      `decideProposal: no undecided proposal ${args.proposalId} in conversation ${args.conversationId}`,
    )
  }
}

/** The cashier's precondition, read by (id, conversation_id) and never by id alone. */
export async function loadProposal(
  sql: postgres.Sql,
  proposalId: string,
  conversationId: string,
): Promise<Proposal | null> {
  const rows = await sql<Row[]>`
    select id, conversation_id, user_id, turn_id, refs, requirements_snapshot,
           decision, decided_at
      from course.proposals
     where id = ${proposalId} and conversation_id = ${conversationId}`
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    turnId: row.turn_id,
    refs: row.refs,
    requirementsSnapshot: row.requirements_snapshot === null
      ? null
      : fromStored(row.requirements_snapshot),
    decision: row.decision,
    decidedAt: row.decided_at,
  }
}
