import type postgres from 'postgres'
import type { Limits } from './engine.js'
import { readSpendFailClosed } from './repo/spend.js'

export type SubmitDeps = {
  sql: postgres.Sql
  limits: Limits
  invoke: (turnId: string) => Promise<void>
}

export type SubmitInput = {
  userId: string
  conversationId: string | null
  message: string
  idempotencyKey: string
}

// `turnId` is `null`, not `''`, when no turn exists to name — an empty string
// sentinel is indistinguishable from a truncated/blank id at a glance and
// invites a `turnId !== ''` check that silently does the wrong thing once a
// real id happens to be falsy-looking in some future refactor. `null` makes
// "no turn" a type-level fact a caller must handle.
export type SubmitResult = {
  conversationId: string
  turnId: string | null
  status: 'queued' | 'duplicate' | 'limit_reached' | 'busy'
}

/**
 * Tier 2: the synchronous request handler. Accepts a message and returns
 * fast, doing no model work itself. Three properties matter here, in order:
 *
 *  1. Fail closed — `readSpendFailClosed` is called, and honored, BEFORE any
 *     message or turn is written. It throws rather than returning 0 when it
 *     cannot confirm current usage, so a database hiccup denies rather than
 *     silently disabling the ceiling at the exact moment it's needed most.
 *  2. Durable before scheduled — the turn row is inserted (and, since this
 *     statement is not wrapped in an explicit multi-statement transaction,
 *     committed) before `invoke` is ever called. `invoke`'s rejection is
 *     swallowed: the turn is already durable at `queued`, and the sweeper
 *     (Task 10) is the backstop that rescues it within a couple of minutes.
 *     Reversed — invoking before the row is committed — a crash in between
 *     would replay work with no durable record it had started.
 *  3. Idempotent — the insert races the `unique (conversation_id,
 *     idempotency_key)` constraint and the partial
 *     `turns_one_active_per_conversation` index in one `on conflict do
 *     nothing` (no conflict target: the partial unique index can't be named
 *     as one anyway, so a bare `do nothing` is the only statement that
 *     tolerates either rejection). A zero-row result is then disambiguated
 *     by reading back on idempotency_key: a match is a `duplicate` retry: no
 *     match means some OTHER turn already holds the active slot and this
 *     request is `busy`.
 */
export async function submitMessage(
  deps: SubmitDeps, input: SubmitInput,
): Promise<SubmitResult> {
  const { sql, limits } = deps

  // Conversation creation stays here, ahead of the spend check, even though a
  // capped-and-brand-new request creates a conversation it then immediately
  // marks 'limit_reached'. Moving creation below the check was considered and
  // rejected: `messages.conversation_id` is NOT NULL with a composite FK to
  // conversations(id, user_id), so a message cannot be attached to a
  // conversation that does not yet exist — and dropping her first message
  // instead (to avoid creating the conversation) would contradict the
  // preservation guarantee below, which this project has already ruled is the
  // worse failure. With the fix below, the created conversation is never
  // actually empty in the sidebar: it holds her message, correctly marked
  // 'limit_reached' instead of looking like inert clutter.
  const conversationId = input.conversationId ?? (
    await sql`insert into conversations (user_id) values (${input.userId}) returning id`
  )[0]!.id as string

  // Fail closed: this throws rather than returning zero when it cannot confirm.
  // Deliberately BEFORE any message or turn is written — a database hiccup here
  // must deny the request outright, not write a message on top of an unconfirmed
  // spend state.
  const spend = await readSpendFailClosed(sql, input.userId, conversationId)

  // Recorded regardless of what happens next, INCLUDING when the ceiling below
  // stops the turn before it starts. An in-flight turn (the `busy` path below)
  // can pick this message up as its next pending user message — see
  // `DecideInput.pendingUserMessage` in engine.ts, which exists for exactly
  // this "she typed again while the agent was still working" case. Dropping
  // the message on `busy` OR `limit_reached` would be the worse failure in
  // both cases: it discards something she typed instead of just delaying who
  // reads it, or telling her she's capped without keeping her words.
  await sql`insert into messages (conversation_id, user_id, role, content)
            values (${conversationId}, ${input.userId}, 'user', ${input.message})`

  if (spend.dailyMicros >= limits.dailyCeilingMicros ||
      spend.conversationMicros >= limits.conversationCeilingMicros) {
    await sql`update conversations set status = 'limit_reached', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return { conversationId, turnId: null, status: 'limit_reached' }
  }

  const inserted = await sql`
    insert into turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${input.userId}, ${input.idempotencyKey})
    on conflict do nothing
    returning id`

  if (inserted.length === 0) {
    const dupe = await sql`
      select id from turns
       where conversation_id = ${conversationId} and idempotency_key = ${input.idempotencyKey}`
    if (dupe.length > 0) {
      return { conversationId, turnId: dupe[0]!.id as string, status: 'duplicate' }
    }
    return { conversationId, turnId: null, status: 'busy' }   // another turn is in flight
  }

  const turnId = inserted[0]!.id as string
  await sql`update conversations set status = 'working', updated_at = now()
             where id = ${conversationId} and user_id = ${input.userId}`

  // Persist first, then schedule. A failed invoke leaves a durable queued turn
  // that the sweeper will pick up within a couple of minutes.
  await deps.invoke(turnId).catch(() => {})

  return { conversationId, turnId, status: 'queued' }
}
