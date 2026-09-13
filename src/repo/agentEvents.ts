import type postgres from 'postgres'

/**
 * What the agency did, in the vocabulary the feed she watches is written in.
 *
 * Seven kinds and not a free string, and the check constraint on
 * `course.agent_events.kind` (migration 0017) holds the same seven, for the
 * reason every other pinned set in this branch is pinned: a kind nobody
 * declared is a row a reader cannot bucket, and "what happened during this
 * turn" is a question somebody asks of the table months later.
 */
export type AgentEventKind =
  | 'tool_start' | 'tool_done' | 'thinking' | 'parked' | 'failed' | 'continued' | 'escalated'

/**
 * Appends one row to the feed. BEST EFFORT: a failure is swallowed and logged,
 * never propagated, exactly as `pgSink` is and for the same reason. This row
 * describes what happened. `reserve` and `reconcile` decide what may happen
 * next, and the two must never share an error path, because a degraded database
 * during a runaway loop would then swallow the guardrail in the failure mode it
 * exists for.
 *
 * `detail` is a short server-written string and never the model's own words. It
 * is a tool name, a fail reason or a slot, so a feed she watches cannot be
 * written by a model that has just read a supplier's page.
 *
 * The one row that is NOT written through here is the escalation
 * (`escalationRunner`, src/tools.ts), which inserts the same shape with its own
 * `returning` and no catch, because `src/worker.ts` reads that row back to
 * decide the conversation's status and a lost write there is a request a person
 * never picks up.
 */
export async function recordAgentEvent(
  sql: postgres.Sql,
  args: { conversationId: string; userId: string; turnId: string | null
          kind: AgentEventKind; detail: string | null },
): Promise<void> {
  try {
    await sql`
      insert into course.agent_events (conversation_id, user_id, turn_id, kind, detail)
      values (${args.conversationId}, ${args.userId}, ${args.turnId}, ${args.kind}, ${args.detail})`
  } catch (err) {
    console.error('recordAgentEvent: feed write failed', { kind: args.kind, err })
  }
}

/**
 * Whether a person has been asked for on this conversation, as one boolean.
 *
 * A separate query rather than `readFeed(...).some(...)`, because the caller is
 * `src/worker.ts`'s completion arm, which runs on every turn that ends with a
 * message, and the feed grows across every turn of a conversation at two rows
 * per tool call. Reading all of it, ordered, to answer one yes or no is a cost
 * that rises with the length of the conversation for an answer whose size never
 * changes. `limit 1` stops at the first row.
 *
 * Scoped by conversation and not by turn, deliberately: nothing in this branch
 * hands a conversation back from the person who picked it up, so a later turn
 * that answered her would otherwise clear the flag and leave a request with a
 * person and a thread that says it is waiting on her.
 */
export async function hasEscalated(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<boolean> {
  const rows = await sql`
    select 1 from course.agent_events
     where conversation_id = ${conversationId} and user_id = ${userId}
       and kind = 'escalated'
     limit 1`
  return rows.length > 0
}

/**
 * The feed, oldest first, by `seq` and never by `created_at`: every row a turn
 * writes lands inside one transaction in the tests, where `now()` is the same
 * instant for all of them, and an order that is not an order is worse than none.
 *
 * Scoped by conversation AND by user, like every read in this directory, so the
 * clause is there whether or not a policy is standing behind it.
 */
export async function readFeed(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<{ kind: AgentEventKind; detail: string | null }[]> {
  return sql<{ kind: AgentEventKind; detail: string | null }[]>`
    select kind, detail from course.agent_events
     where conversation_id = ${conversationId} and user_id = ${userId}
     order by seq`
}
