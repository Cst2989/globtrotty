import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAction, describeActionForUi } from '@/src/actions'

/**
 * Server-side reads for the chat UI, through the RLS-scoped client
 * (`web/supabase/server.ts`'s `createServerSupabase()`) — never the owner
 * connection. Every table these two functions read from carries an
 * `own_*` SELECT policy (supabase/migrations/0016_plan_4_chat.sql) keyed on
 * `user_id = auth.uid()`, so a query here can never return another
 * traveller's row; there is no `.eq('user_id', …)` filter below because the
 * database itself is the one enforcing that boundary.
 */

export type ConversationSummary = {
  id: string
  title: string | null
  status: string
  updated_at: string
  firstMessage: string | null
}

export type ConversationHeader = {
  id: string
  title: string | null
  status: string
  updated_at: string
}

export type ThreadMessage = {
  id: string
  role: 'user' | 'agent' | 'action'
  content: string
  created_at: string
}

export type LatestTurn = {
  status: string
  fail_reason: string | null
}

export type Thread = {
  conversation: ConversationHeader | null
  messages: ThreadMessage[]
  latestTurn: LatestTurn | null
}

/**
 * Fix round 1 (Minor): extracted so `test/web-data.test.ts` can pin the
 * dedup rule — the FIRST row per `conversation_id` wins — without a live
 * DB. Correct only when `rows` already arrives ordered oldest-first per
 * conversation, which `listConversations` guarantees by sorting the whole
 * result set by `created_at` ascending before calling this.
 */
export function firstMessagePerConversation(
  rows: { conversation_id: string; content: string }[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of rows) {
    if (!map.has(r.conversation_id)) map.set(r.conversation_id, r.content)
  }
  return map
}

/**
 * The sidebar's list, newest-first. `firstMessage` (her own opening line,
 * where one exists) stands in for a title until the front desk has set one —
 * see `src/agents/frontDesk.ts`'s `parseFrontVerdict`, which leaves `title`
 * `null` until a conversation is routed to planning.
 *
 * Fix round 1 (Important): bounded two ways.
 *
 * 1. `.limit(50)` on the conversation list itself — an unbounded sidebar
 *    query was one traveller with years of history away from a slow page.
 *
 * 2. The first-message lookup below fetches only `conversation_id, content`
 *    (never the full row) across at most 200 of this user's own oldest
 *    `role='user'` messages, then dedupes client-side by first occurrence
 *    (`firstMessagePerConversation`). A single PostgREST embedded query
 *    (`conversations.select('…, messages(content)')` filtered/limited on
 *    the embedded table) was tried first and is the "correct" shape for
 *    exactly one row per conversation, but `messages` reaches
 *    `conversations` through a COMPOSITE foreign key (`(conversation_id,
 *    user_id) references conversations(id, user_id)`, migration
 *    0001_harness.sql) — PostgREST's embedding relies on inferring a
 *    single-column FK for the embed path, and this project has no live
 *    integration test exercising PostgREST's schema introspection against
 *    that shape to confirm the embedded-filter syntax actually returns one
 *    row per conversation rather than silently mis-joining. Given that
 *    uncertainty and no way to verify it here, this took the fallback the
 *    task explicitly allows instead: one flat, easy-to-reason-about query,
 *    bounded, deduped in JS. The real, bounded-but-real cost: a traveller
 *    whose oldest 200 fetched `role='user'` rows (across ALL her
 *    conversations combined, oldest-first) don't reach some of her 50
 *    listed conversations will see no first-line label for those —
 *    `labelFor` (`web/components/Sidebar.tsx`) still falls back to "New
 *    conversation", never a crash or a wrong label from another
 *    conversation.
 */
export async function listConversations(sb: SupabaseClient): Promise<ConversationSummary[]> {
  const { data: conversations, error } = await sb
    .from('conversations')
    .select('id, title, status, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) throw error
  if (!conversations || conversations.length === 0) return []

  const ids = conversations.map((c) => c.id as string)
  const { data: messages, error: messagesError } = await sb
    .from('messages')
    .select('conversation_id, content')
    .in('conversation_id', ids)
    .eq('role', 'user')
    .order('created_at', { ascending: true })
    .limit(200)
  if (messagesError) throw messagesError

  const firstMessageByConversation = firstMessagePerConversation(
    (messages ?? []) as { conversation_id: string; content: string }[],
  )

  return conversations.map((c) => ({
    id: c.id as string,
    title: c.title as string | null,
    status: c.status as string,
    updated_at: c.updated_at as string,
    firstMessage: firstMessageByConversation.get(c.id as string) ?? null,
  }))
}

/**
 * Fix round 1 (Minor): extracted so `test/web-data.test.ts` can pin this
 * mapping without a live DB. Turns a `role='action'` row's raw JSON
 * (`src/actions.ts`'s `ActionPayload`, written only by
 * `web/messagesRoute.ts` — never a traveller's or agent's free text) into
 * its fixed, ids-free UI sentence via `parseAction`/`describeActionForUi`
 * BEFORE the row ever leaves the server: the JSON (and any id inside it)
 * never enters the RSC payload sent to the browser, let alone reaches
 * `MessageBubble`. A row that fails to parse (a garbled write, a future
 * client bug) falls back to a fixed sentence rather than throwing or
 * leaking the unparseable text. `user`/`agent` rows pass through unchanged.
 */
export function toThreadView(rows: ThreadMessage[]): ThreadMessage[] {
  return rows.map((r) => {
    if (r.role !== 'action') return r
    const action = parseAction(r.content)
    return { ...r, content: action ? describeActionForUi(action) : 'A card action was recorded' }
  })
}

/**
 * One conversation's full transcript plus the latest turn's status (for
 * `StatusLine`). `conversation: null` means either the id does not exist or
 * it belongs to someone else — RLS makes those indistinguishable, which is
 * exactly the property a 404 needs (never confirm another traveller's
 * conversation exists).
 */
export async function loadThread(sb: SupabaseClient, id: string): Promise<Thread> {
  const { data: conversation, error } = await sb
    .from('conversations')
    .select('id, title, status, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!conversation) return { conversation: null, messages: [], latestTurn: null }

  const { data: messages, error: messagesError } = await sb
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
  if (messagesError) throw messagesError

  const { data: turns, error: turnsError } = await sb
    .from('turns')
    .select('status, fail_reason, queued_at')
    .eq('conversation_id', id)
    .order('queued_at', { ascending: false })
    .limit(1)
  if (turnsError) throw turnsError

  const latestTurn = turns && turns.length > 0
    ? { status: turns[0]!.status as string, fail_reason: turns[0]!.fail_reason as string | null }
    : null

  return {
    conversation: {
      id: conversation.id as string,
      title: conversation.title as string | null,
      status: conversation.status as string,
      updated_at: conversation.updated_at as string,
    },
    messages: toThreadView((messages ?? []) as ThreadMessage[]),
    latestTurn,
  }
}
