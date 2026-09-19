import type { SupabaseClient } from '@supabase/supabase-js'

export type SubscribeConversationArgs = {
  conversationId: string
  userId: string
  onChange: () => void
}

/**
 * Browser-only Realtime subscription for one conversation. Two
 * `postgres_changes` listeners on one channel — `conversations` (status
 * flips) and `messages` (new rows) — both filtered server-side to this
 * user's own rows (`user_id=eq.<uid>`), matching the SELECT policies
 * `own_conversations`/`own_messages` in
 * supabase/migrations/0016_plan_4_chat.sql so the browser never even
 * receives a change for a row RLS would refuse to return.
 *
 * `onChange` ignores the payload entirely and just triggers a refetch
 * (`Thread.tsx`'s `ThreadLive` passes `router.refresh()`) — the payload is
 * untrusted, unvalidated wire data; re-reading through the RLS-scoped
 * server read is what actually decides what she sees, exactly once, in one
 * place (`web/data.ts`), rather than this module growing a second copy of
 * that logic to merge a payload in place.
 *
 * Returns an unsubscribe function; the caller (a `useEffect`) is
 * responsible for calling it on unmount.
 */
export function subscribeConversation(
  sb: SupabaseClient,
  { conversationId, userId, onChange }: SubscribeConversationArgs,
): () => void {
  const channel = sb
    .channel(`conv-${conversationId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages', filter: `user_id=eq.${userId}` },
      () => onChange(),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${userId}` },
      () => onChange(),
    )
    .subscribe()

  return () => {
    sb.removeChannel(channel)
  }
}
