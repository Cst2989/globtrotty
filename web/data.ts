import type { SupabaseClient } from '@supabase/supabase-js'

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
 * The sidebar's list, newest-first. `firstMessage` (her own opening line,
 * where one exists) stands in for a title until the front desk has set one —
 * see `src/agents/frontDesk.ts`'s `parseFrontVerdict`, which leaves `title`
 * `null` until a conversation is routed to planning.
 */
export async function listConversations(sb: SupabaseClient): Promise<ConversationSummary[]> {
  const { data: conversations, error } = await sb
    .from('conversations')
    .select('id, title, status, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw error
  if (!conversations || conversations.length === 0) return []

  const ids = conversations.map((c) => c.id as string)
  const { data: messages, error: messagesError } = await sb
    .from('messages')
    .select('conversation_id, content, created_at')
    .in('conversation_id', ids)
    .eq('role', 'user')
    .order('created_at', { ascending: true })
  if (messagesError) throw messagesError

  const firstMessageByConversation = new Map<string, string>()
  for (const m of messages ?? []) {
    const key = m.conversation_id as string
    if (!firstMessageByConversation.has(key)) firstMessageByConversation.set(key, m.content as string)
  }

  return conversations.map((c) => ({
    id: c.id as string,
    title: c.title as string | null,
    status: c.status as string,
    updated_at: c.updated_at as string,
    firstMessage: firstMessageByConversation.get(c.id as string) ?? null,
  }))
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
    messages: (messages ?? []) as ThreadMessage[],
    latestTurn,
  }
}
