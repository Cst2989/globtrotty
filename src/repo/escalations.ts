import type postgres from 'postgres'
import type { Escalation, EscalationReason } from '../notify.js'

/** Spec section 4: rate-limited per user per day. Three is enough for a human to notice a pattern and few enough to stop a loop. */
export const MAX_ESCALATIONS_PER_DAY = 3

/** UTC day, like daily_usage. Throws on a missing row: a failed count is a refusal, not zero. */
export async function countEscalationsToday(sql: postgres.Sql, userId: string, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from escalations
     where user_id = ${userId} and created_at >= ${day + 'T00:00:00Z'}::timestamptz and created_at < (${day + 'T00:00:00Z'}::timestamptz + interval '1 day')`
  const row = rows[0]
  if (!row) throw new Error('countEscalationsToday: no row; refusing to assume zero')
  return row.n
}

/** The row and the status flip commit together; the notifier runs after, outside. */
export async function recordEscalation(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; turnId: string | null; proposalId: string | null; reason: EscalationReason },
): Promise<Escalation> {
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; created_at: Date }[]>`
      insert into escalations (conversation_id, user_id, turn_id, proposal_id, reason)
      values (${args.conversationId}, ${args.userId}, ${args.turnId}, ${args.proposalId}, ${args.reason})
      returning id, created_at`
    await tx`update conversations set status = 'escalated', updated_at = now()
              where id = ${args.conversationId} and user_id = ${args.userId}`
    return { id: e!.id, conversationId: args.conversationId, userId: args.userId, turnId: args.turnId,
      proposalId: args.proposalId, reason: args.reason, createdAt: e!.created_at }
  }) as Promise<Escalation>
}

export async function markNotified(sql: postgres.Sql, escalationId: string): Promise<void> {
  await sql`update escalations set notified_at = now() where id = ${escalationId} and notified_at is null`
}
