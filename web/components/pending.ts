import type { ThreadMessage } from '@/web/data'

/** One optimistic message `ThreadLive` is showing ahead of the server — see that file's doc comment. */
export type PendingMessage = {
  id: string
  content: string
}

/** A `ThreadMessage` row that may be one of `ThreadLive`'s own optimistic entries rather than a server row. */
export type MergedMessage = ThreadMessage & { pending?: boolean }

/**
 * Task 10: the optimistic-send merge. `server` is `loadThread`'s own
 * oldest-first list; `pending` is whatever `ThreadLive` has appended ahead
 * of a refresh landing. A pending entry is dropped once `server` already
 * carries a `user` row with the SAME text — matched by content, since the
 * server row gets its own id and `created_at` the browser could never have
 * predicted when it built the optimistic one. Pure: no `Date.now()`, no
 * randomness, so it is exactly as deterministic as its two inputs.
 *
 * Order: every server row first (already the thread's real order), then
 * whichever pending rows still have no match, in the order they were sent —
 * which is also the only order a message that has not reached the server
 * yet could sensibly render in.
 */
export function mergePending(server: ThreadMessage[], pending: PendingMessage[]): MergedMessage[] {
  const stillPending = pending.filter((p) => !server.some((m) => m.role === 'user' && m.content === p.content))
  const appended: MergedMessage[] = stillPending.map((p) => ({
    id: p.id,
    role: 'user',
    content: p.content,
    created_at: '',
    pending: true,
  }))
  return [...server, ...appended]
}
