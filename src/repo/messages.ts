import type postgres from 'postgres'
import { parseResults, parseChoices, type ResultsContent, type ChoicesContent } from '../results.js'

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

/**
 * The newest `results` row of this `kind` that is NOT itself the output of a filter — the CORPUS
 * a typed filter should be applied over.
 *
 * The final review's I1: `readLatestResults` returns the newest row full stop, and after one
 * typed filter that row IS a filtered row. A second typed filter then narrowed an
 * already-narrowed set, and no typed message could ever widen it again ("show me all flights" ->
 * `applyFilter(items, {})` over the narrowed list -> "Showing 2 of 2: all results"). Spec section
 * 2.2 wants a typed filter applied "as chips" over the stored results, which is this row.
 *
 * Read in JS rather than with a jsonb predicate on `content` because `parseResults` is already
 * the one authority on what a results row means, and a garbled row must be skipped here exactly
 * as it is everywhere else. The 50-row window bounds the scan: it is the newest 50 `results`
 * rows of ANY kind, and a conversation that has written 50 results rows since its last
 * unfiltered search of this kind has long since moved on to a different trip.
 */
export async function readLatestUnfilteredResults(
  sql: postgres.Sql, conversationId: string, userId: string, kind: ResultsContent['kind'],
): Promise<ResultsContent | null> {
  const rows = await sql<{ content: string }[]>`
    select content from messages
     where conversation_id = ${conversationId} and user_id = ${userId} and role = 'results'
     order by created_at desc, id desc
     limit 50`
  for (const row of rows) {
    const parsed = parseResults(row.content)
    if (parsed !== null && parsed.kind === kind && parsed.filter === undefined) return parsed
  }
  return null
}

/**
 * The newest `choices` row for this conversation, with the moment it was written.
 *
 * The content is fix round 1 (Important): `makeRouter`'s `choice` dispatch (src/agents/router.ts)
 * must check her click against what was ACTUALLY offered, never trust `ActionPayload`'s
 * `questionId`/`optionId` on their own (both are just id-shaped strings the client sent; nothing
 * upstream of this read proves they came from a card this office actually rendered). `null` when
 * she has no choice card at all, or the newest one fails `parseChoices` (a garbled write — never
 * something our own writer produces), either of which `makeRouter` treats as "nothing was
 * offered", same as a genuine mismatch.
 *
 * `createdAt` is the final review's C3: the card is the dividing line between what she TYPED and
 * what she CLICKED, so it is what `readNewestUserTextBefore` needs to recover the request intake
 * should re-run on.
 */
export type StoredChoices = { choices: ChoicesContent; createdAt: Date }

export async function readLatestChoices(
  sql: postgres.Sql, conversationId: string, userId: string,
): Promise<StoredChoices | null> {
  const rows = await sql<{ content: string; created_at: Date }[]>`
    select content, created_at from messages
     where conversation_id = ${conversationId} and user_id = ${userId} and role = 'choices'
     order by created_at desc, id desc
     limit 1`
  const row = rows[0]
  if (!row) return null
  const choices = parseChoices(row.content)
  return choices === null ? null : { choices, createdAt: row.created_at }
}

/**
 * The newest TYPED `user` message strictly older than `before`, or `null` when there is none.
 *
 * The final review's C3. `src/handler.ts`'s `submitAction` writes her click as a `user` row
 * (`userNote` — `ChoiceCardLive` always sends the option's label) immediately before the `action`
 * row, and `loop()` hydrates every `user` row into the transcript, so the newest `user` entry
 * `ctx.state.messages` can offer is the label "Barcelona", not the trip request. Re-running
 * intake on that loses the trip: "a week somewhere, flying from where I usually do" becomes
 * "Barcelona", the destination and dates vanish, and she gets another card.
 *
 * `before` is the choice card's own `created_at` (`readLatestChoices`), which is strictly older
 * than any click on it.
 *
 * A click note is also EXCLUDED outright, not just by being newer than the card: a `userNote` is
 * always the row immediately before an `action` row (that is the only thing that writes the
 * pair, and `clock_timestamp()` orders them that way on purpose), so "the next row is an action"
 * identifies one exactly. Without that, a second card in the same chain — she clicks the origin
 * card, intake re-runs and asks for the destination, she clicks that too — would re-run on the
 * FIRST click's label instead of her request, which is the same bug one card further along.
 * `lead(...)` over the whole conversation is cheap here: these transcripts are tens of rows.
 */
export async function readNewestUserTextBefore(
  sql: postgres.Sql, conversationId: string, userId: string, before: Date,
): Promise<string | null> {
  const rows = await sql<{ content: string }[]>`
    with ordered as (
      select role, content, created_at, id,
             lead(role) over (order by created_at, id) as next_role
        from messages
       where conversation_id = ${conversationId} and user_id = ${userId}
    )
    select content from ordered
     where role = 'user' and created_at < ${before} and coalesce(next_role, '') <> 'action'
     order by created_at desc, id desc
     limit 1`
  const row = rows[0]
  return row && row.content.length > 0 ? row.content : null
}
