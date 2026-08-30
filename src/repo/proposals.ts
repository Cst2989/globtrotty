import type postgres from 'postgres'
import type { ItemRef } from '../gates/types.js'

export type Proposal = {
  id: string
  conversationId: string
  userId: string
  turnId: string | null
  refs: ItemRef[]
  decision: 'accept' | 'reject' | null
  decidedAt: Date | null
}

type Row = {
  id: string; conversation_id: string; user_id: string; turn_id: string | null
  refs: ItemRef[]; decision: 'accept' | 'reject' | null; decided_at: Date | null
}

/**
 * Writes what the gates approved, and returns its id so the model can refer to
 * it. The refs stored are the ones `ProposalRefsSchema` validated, never the
 * raw object the model sent: the row is the server's record of what it
 * approved, and a row built from unvalidated input would be a record of what it
 * was asked to approve.
 */
export async function recordProposal(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; turnId: string | null; refs: ItemRef[] },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into course.proposals (conversation_id, user_id, turn_id, refs)
    values (${args.conversationId}, ${args.userId}, ${args.turnId}, ${sql.json(args.refs as never)})
    returning id`
  if (!row) throw new Error('recordProposal: insert returned no row')
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
    select id, conversation_id, user_id, turn_id, refs, decision, decided_at
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
    decision: row.decision,
    decidedAt: row.decided_at,
  }
}
