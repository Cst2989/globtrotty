import type { SupabaseClient } from '@supabase/supabase-js'

export type SubscribeConversationArgs = {
  conversationId: string
  userId: string
  onChange: () => void
}

/** How long to wait after the LAST change in a burst before actually refetching. */
const DEBOUNCE_MS = 250

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
 * Fix round 1 (Important): `onChange` is debounced 250ms, trailing —
 * repeated inside this function (not by the caller) so every caller gets it
 * for free. A single turn can touch `conversations` (the `working` →
 * `active`/`awaiting_user` flip) and write several `messages` rows in quick
 * succession; without this, each one fired its own `router.refresh()`,
 * turning one turn's worth of progress into a burst of redundant server
 * round-trips instead of one refetch after the burst settles.
 *
 * Returns an unsubscribe function; the caller (a `useEffect`) is
 * responsible for calling it on unmount. Unsubscribing cancels a pending
 * debounced call too — a change that arrives right before unmount must
 * never fire `onChange` against an already-torn-down component.
 */
export function subscribeConversation(
  sb: SupabaseClient,
  { conversationId, userId, onChange }: SubscribeConversationArgs,
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null

  const debouncedOnChange = () => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      onChange()
    }, DEBOUNCE_MS)
  }

  const channel = sb
    .channel(`conv-${conversationId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages', filter: `user_id=eq.${userId}` },
      () => debouncedOnChange(),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${userId}` },
      () => debouncedOnChange(),
    )
    .subscribe()

  return () => {
    if (pending) clearTimeout(pending)
    sb.removeChannel(channel)
  }
}
