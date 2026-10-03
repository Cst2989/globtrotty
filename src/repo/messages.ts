import type postgres from 'postgres'
import { parseResults, type ResultsContent } from '../results.js'

export type StoredMessageRow = { role: 'user' | 'agent' | 'action' | 'results' | 'choices'; content: string }

/**
 * The newest row of this conversation's own transcript, by `created_at` (ties broken by `id`,
 * same tiebreak `rehydrate` uses in src/repo/toolResults.ts) — the RAW role and content, before
 * any hydration. `src/worker.ts`'s `loop()` turns every `action`/`results`/`choices` row into a
 * `system` message with its own rendered text the moment it loads a turn's transcript, which is
 * exactly what makes "was the newest stored row an action, and which kind" unanswerable from
 * `ctx.state.messages` alone — this is the one query that still can tell. Plan 5 Task 6: the
 * router (src/agents/router.ts) calls this first, before deciding whether to run `routeMessage`
 * at all or hand straight to an action handler.
 */
export async function readNewestMessage(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<StoredMessageRow | null> {
  const rows = await sql<StoredMessageRow[]>`
    select role, content from messages
     where conversation_id = ${conversationId} and user_id = ${userId}
     order by created_at desc, id desc
     limit 1`
  return rows[0] ?? null
}

/**
 * The newest `results` row's own content for this conversation — the router's `filter` step reads
 * it to know what to filter and re-attach, and `routeMessage`'s `hasResults`/`lastQuery` state
 * fields come from it too (src/agents/router.ts). `null` when she has no results yet, or when the
 * newest one fails `parseResults` (a garbled write — never something our own writer produces).
 */
export async function readLatestResults(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<ResultsContent | null> {
  const rows = await sql<{ content: string }[]>`
    select content from messages
     where conversation_id = ${conversationId} and user_id = ${userId} and role = 'results'
     order by created_at desc, id desc
     limit 1`
  const row = rows[0]
  return row ? parseResults(row.content) : null
}
