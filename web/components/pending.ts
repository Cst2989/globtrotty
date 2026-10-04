/**
 * Trip-stage pass, section 1: the pure half of the optimistic store — what the screen is allowed
 * to claim ahead of the server, and exactly when the server has caught up with it.
 *
 * No React, no DOM, no clock of its own, so `test/web-optimistic.test.ts` pins every settle rule
 * directly. The provider that holds this state is `./optimistic.tsx`; the builder that turns a
 * server-rendered page into a `ServerState` is `serverStateFor` below, which the conversation
 * page calls and so must not live inside a `'use client'` module.
 *
 * This replaced pass 3's per-component flags — `ResultsPaneLive`'s own `pendingChoice` and its
 * `pendingLanded` hotfix, `ThreadLive`'s own `pendingMessages`, `ActivityProvider`'s `busy`.
 * The screenshot at 16.15 is what three separate answers to "has the server caught up" cost:
 * the pane had already drawn the hotels skeleton while the chat was still a thread with nothing
 * in it about a flight having been chosen.
 */
import type { ProposalRowLite, ResultsView, ThreadMessage } from '@/web/data'

/** What a pending ACTION is. One per click; `sourceId` is what the settle rule looks for. */
export type PendingActionKind =
  /** A Select pressed on a flight card. `sourceId` is the card's. */
  | 'choose_flight'
  /** A Select pressed on a hotel card. `sourceId` is the card's. */
  | 'choose_hotel'
  /** `Accept this trip` pressed. `sourceId` is the proposal's id. */
  | 'accept'
  /** `Refresh prices` pressed. `sourceId` is the `results` row it was fired against. */
  | 'refresh'
  /** An option on a question card clicked. */
  | 'choice'
  /** A next-step chip clicked. */
  | 'next'

/** The one action the screen is claiming right now, as its readers see it. */
export type PendingAction = {
  kind: PendingActionKind
  /** The words the chat's centred note reads, or `''` for an action that is not narrated. */
  label: string
  /** `Date.now()` at the click, in the browser that made it. */
  at: number
  sourceId?: string
}

/** Everything the settle rules read: one snapshot per render, shared by both islands. */
export type ServerState = {
  /** Every `user` row's text, in thread order. Only the COUNT per text is ever read; see below. */
  userMessages: string[]
  /** Every `results` row, oldest first. */
  resultRows: { messageId: string; kind: 'flights' | 'hotels'; at: number }[]
  /** Every proposal, NEWEST first — `loadProposals`'s own order. */
  proposals: {
    id: string
    decision: 'accept' | 'reject' | null
    /** Every item's `sourceId`, so a choose can ask "is my card in here". */
    sourceIds: string[]
    hasFlight: boolean
    hasStay: boolean
  }[]
}

export const EMPTY_SERVER_STATE: ServerState = { userMessages: [], resultRows: [], proposals: [] }

/**
 * How long anything is allowed to stand with no answer from the server.
 *
 * Twenty seconds, the same backstop the price skeleton already used and for the same reason: a
 * real round trip is never cut off by it, and nobody sits in front of a note about something
 * that already failed somewhere this component cannot see.
 */
export const PENDING_BACKSTOP_MS = 20_000

/**
 * One entry of the store. A message and an action are the same kind of thing — something the
 * screen is claiming ahead of the server — so they are one list with one settle function, which
 * is what makes `add`/`resolve`/`fail` a trio rather than two parallel sets.
 */
export type PendingEntry = {
  id: string
  at: number
  kind: 'message' | PendingActionKind
  /** A message's text; an action's note copy ('' for one that is not narrated). */
  text: string
  sourceId?: string
  idempotencyKey?: string
  /**
   * How many `user` rows already carried this exact text when the entry was added.
   *
   * The rule is "a user row with the same text NEWER than `at`", and this is how that is read
   * without trusting two clocks to agree: `at` comes from the browser and `created_at` from
   * Postgres, and a second of skew either way would otherwise leave a bubble doubled for the
   * whole backstop. Counting answers the same question — is this row one the server did not have
   * before — and answers it the same way for two identical messages sent in a row.
   */
  seenCount: number
  failed: boolean
}

/** Whether `server` has caught up with one entry. Pure. */
export function settlePending(server: ServerState, entry: PendingEntry, now: number): boolean {
  if (now - entry.at >= PENDING_BACKSTOP_MS) return true

  switch (entry.kind) {
    // Her own words, however they were sent: typed into the composer, or posted as the label of
    // a chip or of a question card's option.
    case 'message':
    case 'choice':
    case 'next':
      return countOf(server.userMessages, entry.text) > entry.seenCount

    // The office answers a chosen flight by searching stays AND by recording a flights-only
    // proposal; whichever lands first is the server having caught up.
    case 'choose_flight':
      return server.resultRows.some((r) => r.kind === 'hotels' && r.at > entry.at)
        || server.proposals.some((p) => p.hasFlight && hasSource(p.sourceIds, entry.sourceId))

    // A chosen stay has exactly one answer: a proposal that holds it.
    case 'choose_hotel':
      return server.proposals.some((p) => p.hasStay && hasSource(p.sourceIds, entry.sourceId))

    // Accepted: either the proposal she pressed carries a decision now, or the cashier has
    // already replaced it with a newer one (an item sold out and was swapped).
    case 'accept': {
      const newest = server.proposals[0]
      if (!newest) return false
      return newest.decision !== null || (entry.sourceId !== undefined && newest.id !== entry.sourceId)
    }

    // A refresh is answered by a DIFFERENT newest row of the kind it was fired against. The kind
    // is read off the row it named rather than carried separately, so the rule cannot go out of
    // step with what was actually on screen.
    case 'refresh': {
      const rows = server.resultRows
      const from = rows.findIndex((r) => r.messageId === entry.sourceId)
      if (from === -1) return rows.some((r) => r.at > entry.at)
      const kind = rows[from]!.kind
      return rows.slice(from + 1).some((r) => r.kind === kind)
    }
  }
}

function countOf(values: string[], text: string): number {
  let n = 0
  for (const value of values) if (value === text) n++
  return n
}

/** An entry with no `sourceId` settles on the SHAPE alone — the id is a narrowing, not a gate. */
function hasSource(sourceIds: string[], sourceId: string | undefined): boolean {
  return sourceId === undefined || sourceIds.includes(sourceId)
}

/**
 * The note a pending action reads in the chat, or `''` for one that is not narrated.
 *
 * The three that ARE narrated say exactly what `describeActionForUi` (src/actions.ts) says for
 * the same action a round trip later, which is what lets the optimistic note be replaced by the
 * real row without a word on screen changing.
 */
export function actionNote(kind: PendingActionKind): string {
  switch (kind) {
    case 'choose_flight': return 'You chose a flight'
    case 'choose_hotel': return 'You chose a hotel'
    case 'accept': return 'You accepted the trip'
    // A refresh is bookkeeping, and a chip or an option already shows as her own bubble — the
    // same two silences `describeActionForUi` keeps on the server side.
    case 'refresh':
    case 'choice':
    case 'next':
      return ''
  }
}

/**
 * The snapshot the settle rules read, from what the conversation page already loaded.
 *
 * Nothing is fetched for it and nothing is derived that the page did not have: this is a
 * projection, so the store can never be looking at a different truth from the one the pane and
 * the thread are rendering.
 */
export function serverStateFor(input: {
  messages: ThreadMessage[]
  results: ResultsView[]
  /** `loadProposals`'s own newest-first list. */
  proposals: ProposalRowLite[]
}): ServerState {
  const times = resultTimesFor(input.messages)
  return {
    userMessages: input.messages.filter((m) => m.role === 'user').map((m) => m.content),
    resultRows: input.results.map((r) => ({
      messageId: r.messageId,
      kind: r.kind,
      at: times[r.messageId] ?? 0,
    })),
    proposals: input.proposals.map((p) => ({
      id: p.id,
      decision: p.decision,
      sourceIds: p.items.map((i) => i.sourceId),
      hasFlight: p.items.some((i) => i.kind === 'flight'),
      hasStay: p.items.some((i) => i.kind === 'hotel'),
    })),
  }
}

/**
 * `messageId` -> epoch ms, for every `results` row in the transcript.
 *
 * `ResultsView` does not carry its row's own timestamp (it never needed one) and the thread
 * does: `loadThread` returns every row with its `created_at`. So the two are joined here rather
 * than widening the view type for one rule.
 */
export function resultTimesFor(messages: ThreadMessage[]): Record<string, number> {
  const times: Record<string, number> = {}
  for (const m of messages) {
    if (m.role !== 'results') continue
    const at = Date.parse(m.created_at)
    times[m.id] = Number.isNaN(at) ? 0 : at
  }
  return times
}

/** One optimistic message the store is showing ahead of the server. */
export type PendingMessage = {
  id: string
  content: string
  at: number
  /**
   * The key the POST went out with. A retry re-posts with the SAME one, so the route's own
   * idempotency check dedupes it rather than writing her words twice.
   */
  idempotencyKey: string
  /** The POST came back unusable: the bubble offers `Not sent, tap to retry`. */
  failed: boolean
}

/** A `ThreadMessage` row that may be one of the store's own optimistic entries. */
export type MergedMessage = ThreadMessage & { pending?: boolean; pendingId?: string; failed?: boolean }

/**
 * The optimistic-send merge. `server` is `loadThread`'s own oldest-first list; `pending` is
 * whatever the store still has unsettled.
 *
 * Unlike the version this replaced, nothing is dropped here: the store has already settled
 * everything the server carries (see `settlePending`), so a pending entry that reaches this
 * function is one with no server row behind it yet. Order: every server row first, then the
 * pending ones in the order they were sent, which is the only order a message that has not
 * reached the server could sensibly render in.
 */
export function mergePending(server: ThreadMessage[], pending: PendingMessage[]): MergedMessage[] {
  const appended: MergedMessage[] = pending.map((p) => ({
    id: p.id,
    role: 'user',
    content: p.content,
    created_at: '',
    pending: true,
    pendingId: p.id,
    failed: p.failed,
  }))
  return [...server, ...appended]
}
