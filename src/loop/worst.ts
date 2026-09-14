import type postgres from 'postgres'

/** One conversation worth thirty minutes of somebody's Monday. */
export type WorstConversation = {
  conversationId: string
  status: string
  rejected: number
  capped: number
  escalated: boolean
  score: number
}

/**
 * The rule, written down rather than implied by an ORDER BY, because the whole
 * value of a weekly read is that the reader knows why these conversations and
 * not others.
 */
export const WORST_RULE =
  'A conversation scores one point per proposal she rejected, one per turn that stopped on a '
  + 'spending ceiling, and one if it ended with a person. Nothing here is weighted, because a '
  + 'weighting is a claim about which failure costs more and nobody has measured that yet.'

/**
 * The worst conversations, worst first.
 *
 * Three scalar subqueries rather than three joins, because joining proposals
 * and turns to one conversation multiplies their rows against each other and
 * the count that comes out is the product rather than either number. The query
 * is small and the tables are indexed on the columns it filters, which is what
 * `proposals_by_conversation` (0013) and `turns_live` (0001) already are.
 *
 * Ties break on the conversation id and never on `created_at`, for the reason
 * every read on this branch gives: rows written in one transaction share one
 * timestamp, and an unstable order means the same week's read shows a different
 * list to two people.
 *
 * Deliberately NOT scoped by user. This is an operator's read, it runs on the
 * owner connection the way `scripts/messages.ts` does, and a per-user version
 * would answer "what went wrong for this traveller", which is a support
 * question and not a loop question. `course.conversations` is under a policy
 * (0017) and this query would return nothing at all through a `course_worker`
 * session, which is correct and is why the script says which connection it
 * wants.
 */
export async function worstConversations(
  sql: postgres.Sql, args: { limit?: number } = {},
): Promise<WorstConversation[]> {
  const rows = await sql<{
    id: string; status: string; rejected: number; capped: number; escalated: boolean
  }[]>`
    select c.id, c.status,
           (select count(*) from course.proposals p
             where p.conversation_id = c.id and p.decision = 'reject')::int as rejected,
           (select count(*) from course.turns t
             where t.conversation_id = c.id and t.fail_reason = 'limit_reached')::int as capped,
           (c.status = 'escalated') as escalated
      from course.conversations c
     order by (
       (select count(*) from course.proposals p
         where p.conversation_id = c.id and p.decision = 'reject')
       + (select count(*) from course.turns t
           where t.conversation_id = c.id and t.fail_reason = 'limit_reached')
       + (case when c.status = 'escalated' then 1 else 0 end)
     ) desc, c.id
     limit ${args.limit ?? 10}`
  return rows
    .map((r) => ({
      conversationId: r.id,
      status: r.status,
      rejected: r.rejected,
      capped: r.capped,
      escalated: r.escalated,
      score: r.rejected + r.capped + (r.escalated ? 1 : 0),
    }))
    // A conversation that went fine is not a worst conversation, and padding
    // the list to ten with healthy ones is how a weekly read becomes a ritual
    // nobody reads.
    .filter((r) => r.score > 0)
}

export function renderWorst(rows: readonly WorstConversation[]): string {
  if (rows.length === 0) return `nothing to read this week\n\n${WORST_RULE}`
  const lines = rows.map((r) =>
    `  ${r.conversationId}  score ${r.score}  ${r.status.padEnd(14)}`
    + `${r.rejected} rejected, ${r.capped} capped${r.escalated ? ', escalated' : ''}`)
  return [`the ${rows.length} worst conversations`, ...lines, '', WORST_RULE].join('\n')
}
