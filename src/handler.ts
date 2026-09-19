import type postgres from 'postgres'
import { ActionPayload } from './actions.js'
import { readDesk, type Desk } from './repo/conversations.js'
import { exceedsAnyCeiling } from './engine.js'
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

export type SubmitActionInput = {
  userId: string
  conversationId: string
  action: ActionPayload
  idempotencyKey: string
  /**
   * Plan 4a, Task 8: her typed reject reason, stored as an ordinary
   * `role = 'user'` message in the SAME transaction as the action row,
   * immediately before it. `src/actions.ts`'s `rejected` payload deliberately
   * carries no `reason` field — the driver's operator text says "her reason,
   * if she gave one, is in her own message" — so the decide route passes the
   * reason here rather than folding it into the action's JSON. Undefined (or
   * blank) writes nothing; when a fresh turn cannot be won (a retry, a
   * concurrent turn), this note is not written either — same all-or-nothing
   * guarantee the action row itself gets, so a reason never ends up attached
   * to a turn that never runs.
   */
  userNote?: string
  /**
   * Fix round 1 (Task 8 review, Critical). Runs INSIDE the fresh turn's own
   * transaction, right after the turn row is inserted and before the
   * note/action rows — so it only ever runs when a turn was actually WON,
   * never on a `busy`/`duplicate` result, and any throw inside it rolls back
   * the whole transaction (the turn insert included; postgres.js rolls back
   * `sql.begin`'s callback on an uncaught throw and rethrows to the caller).
   *
   * The decide route uses this to make `decideProposal` atomic with the
   * hand-off/rejected action turn it authorises: recording the decision
   * BEFORE calling `submitAction` (the original shape) could leave an
   * accepted proposal with `decision = 'accept'` but no hand-off turn ever
   * queued — a turn already in flight, or the account's spend ceiling,
   * both fail AFTER the decision would already have been written, with no
   * way back once the cashier's own 30-minute acceptance window has since
   * expired. Folding the write into the same transaction as the turn that
   * is supposed to act on it means a decision is recorded if and only if a
   * turn was actually queued to read it.
   *
   * MUST use the `tx` handle it is given — never close over the root `sql`
   * (or any other connection) instead. `tx` is the same transaction that
   * just won the insert against `turns_one_active_per_conversation` (the
   * partial unique index the whole "one turn in flight" guarantee rests
   * on); that lock is held until `tx` commits or rolls back. A query run on
   * a DIFFERENT connection inside this callback — even a read of the same
   * conversation's own rows — can block behind a lock this very
   * transaction holds, and since nothing can make `tx` itself proceed until
   * that other connection's query returns, the two wait on each other
   * forever. Every statement `onFreshTurn` needs must run on `tx`.
   */
  onFreshTurn?: (tx: postgres.TransactionSql) => Promise<void>
}

/**
 * Thrown by `submitAction` when the conversation is not yet at the planning
 * desk. A card action names a `proposal_id` — nothing at the front desk ever
 * has one, so a route handler that lets one through there is a bug upstream
 * (a stale card rendered from a cached page, a race with `routeToPlanning`),
 * not a state `submitAction` should quietly paper over by routing it anyway.
 */
export class ActionRefused extends Error {
  constructor(readonly desk: Desk) {
    super(`submitAction: conversation is at the '${desk}' desk, not 'planning'`)
    this.name = 'ActionRefused'
  }
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
 *     Read that function's doc comment for how far the guarantee reaches: the
 *     conversation read is the one that throws, and the daily and global reads
 *     ride on it rather than adding a guarantee of their own.
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

  // All three ceilings, not two — and via `exceedsAnyCeiling`, the same
  // predicate `decideNext` uses, rather than a second copy of the same three
  // comparisons. The global one is checked at this tier rather than left to the
  // worker because a capped ACCOUNT must be refused before a turn is queued at
  // all — otherwise the refusal arrives one step into the turn, after a model
  // call has already been paid for, which is precisely the spend the ceiling
  // exists to prevent. Note it can fire while both of this user's own counters
  // read zero: it protects the account, not the user.
  if (exceedsAnyCeiling(spend, limits)) {
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

/**
 * The operator channel's tier 2: a card press (accept / reject / revise),
 * rather than typed text, becomes a `messages` row. Mirrors `submitMessage`
 * above property for property — same fail-closed spend read ahead of any
 * write, same durable-before-scheduled turn insert, same idempotency race,
 * same `working` flip and best-effort `invoke` — everything here is that
 * same shape with one row's role and content swapped, and one guard added:
 *
 * `submitAction` never creates a conversation. A card exists only once a
 * conversation has a `proposal_id` to name, which only happens at the
 * planning desk — so unlike `submitMessage`, `conversationId` is required and
 * there is nothing for this function to create on her behalf. `readDesk`
 * enforces the other half of that: a conversation not (yet, or no longer) at
 * `'planning'` refuses with `ActionRefused` rather than writing an action row
 * nothing downstream is set up to read.
 */
export async function submitAction(
  deps: SubmitDeps, input: SubmitActionInput,
): Promise<SubmitResult> {
  const { sql, limits, invoke } = deps
  const { conversationId } = input

  // Validated before anything reaches the database. `SubmitActionInput`
  // types `action` as `ActionPayload` at compile time, which a caller that
  // built its own request body by hand (a route handler decoding JSON off
  // the wire) can defeat — `.parse` re-checks the actual value and throws on
  // anything malformed, rather than letting a bad payload reach `JSON.
  // stringify` and land as a row nothing downstream (`parseAction`) can read
  // back.
  ActionPayload.parse(input.action)

  const desk = await readDesk(sql, conversationId, input.userId)
  if (desk !== 'planning') throw new ActionRefused(desk)

  // Fail closed, same as submitMessage: BEFORE any message or turn is written.
  const spend = await readSpendFailClosed(sql, input.userId, conversationId)

  if (exceedsAnyCeiling(spend, limits)) {
    await sql`update conversations set status = 'limit_reached', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return { conversationId, turnId: null, status: 'limit_reached' }
  }

  /**
   * Turn insert FIRST, action row SECOND — the reverse of `submitMessage`'s
   * order, and deliberately so. A typed message is HER words: dropping it
   * would lose something she said, which is why `submitMessage` preserves it
   * even when the turn cannot start. A card press is not that: it is an
   * instruction meant for exactly one turn. If this call does not create a
   * FRESH turn — a retry that lands while another turn already holds the
   * active slot, or a genuine duplicate of an idempotency key already
   * served — writing the action row anyway would leave it sitting in the
   * transcript for some OTHER, unrelated turn to read and act on later,
   * carrying out the same press twice. Unlike a typed message, an operator
   * instruction must not be preserved for a later turn: a press during a
   * running turn is refused (409 upstream) and can simply be repeated once
   * she sees that.
   *
   * The turn insert, the action row and the `working` flip commit together
   * in one transaction: a crash between "the turn exists" and "the action
   * row exists" would otherwise let a turn run with no instruction to read,
   * or leave an action row orphaned under a turn never marked `working`.
   */
  const freshTurnId = await sql.begin(async (tx) => {
    const inserted = await tx`
      insert into turns (conversation_id, user_id, idempotency_key)
      values (${conversationId}, ${input.userId}, ${input.idempotencyKey})
      on conflict do nothing
      returning id`
    if (inserted.length === 0) return null

    const turnId = inserted[0]!.id as string

    // The turn is WON at this point — `onFreshTurn` (if given) runs now, not
    // before the insert above, so a throw here (e.g. `decideProposal`'s
    // "already decided") rolls back the turn along with it: see this
    // input field's own doc comment.
    if (input.onFreshTurn) await input.onFreshTurn(tx)

    if (input.userNote && input.userNote.trim().length > 0) {
      await tx`insert into messages (conversation_id, user_id, role, content)
                values (${conversationId}, ${input.userId}, 'user', ${input.userNote})`
    }
    // Fix round 1 (Task 8 review, Important): `created_at` is explicitly
    // `clock_timestamp()`, not the column's own `now()` default, so the
    // action row's timestamp is always strictly later than the note's —
    // `now()` is fixed for the whole transaction in Postgres, so the note
    // (inserted just above, with the column default) and the action would
    // otherwise share the exact same `created_at`, leaving their read-back
    // order to depend on an untested tiebreak (insertion order/id) rather
    // than the timestamp a reader actually sorts by.
    await tx`insert into messages (conversation_id, user_id, role, content, created_at)
              values (${conversationId}, ${input.userId}, 'action', ${JSON.stringify(input.action)}, clock_timestamp())`
    await tx`update conversations set status = 'working', updated_at = now()
               where id = ${conversationId} and user_id = ${input.userId}`
    return turnId
  }) as string | null

  if (freshTurnId === null) {
    const dupe = await sql`
      select id from turns
       where conversation_id = ${conversationId} and idempotency_key = ${input.idempotencyKey}`
    if (dupe.length > 0) {
      return { conversationId, turnId: dupe[0]!.id as string, status: 'duplicate' }
    }
    return { conversationId, turnId: null, status: 'busy' }   // another turn is in flight; no action row written
  }

  // Persist first, then schedule — same ordering guarantee as submitMessage.
  await invoke(freshTurnId).catch(() => {})

  return { conversationId, turnId: freshTurnId, status: 'queued' }
}
