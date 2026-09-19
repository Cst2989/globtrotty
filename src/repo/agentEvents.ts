import type postgres from 'postgres'

/** Matches agent_events.kind's check constraint (migration 0001, extended by 0016 with 'screened'). */
export type AgentEventKind =
  | 'tool_start' | 'tool_done' | 'thinking' | 'parked' | 'failed' | 'continued' | 'screened'

/**
 * The feed's one writer. `agent_events` is a nice-to-have alongside whatever
 * durable outcome it describes (a completed turn, an escalation, a screened
 * reply) — never the thing that blocks it. This function itself does not
 * decide that: every current call site (`src/worker.ts`) wraps its own call
 * in a best-effort `.catch`, the same way `escalate.ts`'s notifier call
 * decides for itself rather than this function deciding for every caller.
 */
export async function recordAgentEvent(
  sql: postgres.Sql,
  args: {
    conversationId: string
    userId: string
    turnId: string | null
    kind: AgentEventKind
    payload: Record<string, unknown>
  },
): Promise<void> {
  await sql`insert into agent_events (conversation_id, user_id, turn_id, kind, payload)
            values (${args.conversationId}, ${args.userId}, ${args.turnId},
                    ${args.kind}, ${sql.json(args.payload as never)})`
}
