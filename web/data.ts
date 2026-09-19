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

/** One itinerary line, trimmed from `proposals.itinerary` for the card. */
export type ProposalItemLite = {
  slot: string
  sourceId: string
  kind: 'flight' | 'hotel'
  name: string
  priceMinor: string
  currency: string
  fetchedAt: string
}

export type ProposalRowLite = {
  id: string
  totalMinor: string
  currency: string
  gateOutcome: 'approved' | 'shipped_unapproved' | 'rejected'
  reviewIssues: string[]
  decision: 'accept' | 'reject' | null
  items: ProposalItemLite[]
}

export type LinkLite = {
  itemId: string
  url: string
  quotedMinor: string
  currency: string
}

/** One corpus row from `tool_results`, trimmed for the swap picker. */
export type AlternativeLite = {
  sourceId: string
  name: string
  priceMinor: string
  currency: string
  fetchedAt: string
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
 *
 * Fix round 2 (Task 7 review, item 2): the message query is bounded
 * (`.limit(500)`, newest-first) rather than unbounded — a long-running
 * conversation is otherwise a slow, ever-growing page load on every render.
 * It is fetched newest-first so the `limit` keeps the RECENT 500, then
 * reversed back to oldest-first for display (the order every caller of
 * `loadThread` — `ThreadView`, the sidebar's first-message logic elsewhere —
 * already assumes). A conversation past 500 messages loses its EARLIEST
 * turns from view; there is no pagination yet, so they are simply not shown.
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
    .order('created_at', { ascending: false })
    .limit(500)
  if (messagesError) throw messagesError
  const oldestFirst = [...(messages ?? [])].reverse()

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
    messages: toThreadView(oldestFirst as ThreadMessage[]),
    latestTurn,
  }
}

type StoredItineraryLike = { items?: unknown }
type StoredItineraryItemLike = {
  slot?: unknown; sourceId?: unknown; kind?: unknown; name?: unknown
  priceMinor?: unknown; currency?: unknown; fetchedAt?: unknown
}

/**
 * Trims `proposals.itinerary` (the REHYDRATED snapshot `src/repo/proposals.ts`
 * wrote — never the model's own version, see that module's doc comment) down
 * to the five fields the card renders. Never throws: a shape this reader does
 * not recognise (a future schema version, a hand-edited row) yields an empty
 * item list rather than a 500 — the card still shows the total, the gate
 * outcome and the buttons even if an individual line cannot be read.
 */
export function itineraryItemsLite(itinerary: unknown): ProposalItemLite[] {
  const items = (itinerary as StoredItineraryLike | null)?.items
  if (!Array.isArray(items)) return []
  const out: ProposalItemLite[] = []
  for (const raw of items as StoredItineraryItemLike[]) {
    const { slot, sourceId, kind, name, priceMinor, currency, fetchedAt } = raw
    if (
      typeof slot !== 'string' || typeof sourceId !== 'string' || typeof name !== 'string'
      || typeof priceMinor !== 'string' || typeof currency !== 'string' || typeof fetchedAt !== 'string'
      || (kind !== 'flight' && kind !== 'hotel')
    ) continue
    out.push({ slot, sourceId, kind, name, priceMinor, currency, fetchedAt })
  }
  return out
}

/**
 * Fix round 1 (this task): extracted so the newest-per-`sourceId` dedup rule
 * for the swap picker's corpus reads is pinned without a live DB — same
 * shape of test as `firstMessagePerConversation` above. Correct only when
 * `rows` already arrives newest-first, which `loadAlternatives` guarantees by
 * ordering on `fetched_at` descending before calling this.
 */
export function newestAlternativePerSourceId(
  rows: { source_id: string; name: string; price_minor: string; currency: string; fetched_at: string }[],
): AlternativeLite[] {
  const seen = new Set<string>()
  const out: AlternativeLite[] = []
  for (const r of rows) {
    if (seen.has(r.source_id)) continue
    seen.add(r.source_id)
    out.push({
      sourceId: r.source_id, name: r.name, priceMinor: String(r.price_minor),
      currency: r.currency, fetchedAt: r.fetched_at,
    })
  }
  return out
}

/**
 * Proposals for one conversation, newest first, itinerary items trimmed via
 * `itineraryItemsLite`. Links are read only for proposals already accepted —
 * spec §2: "After accept, the card shows the links from `link_clicks` as the
 * only anchors on the page" — a decided-`'reject'`-or-undecided proposal
 * gets an empty `links` array rather than a wasted query.
 */
export async function loadProposals(
  sb: SupabaseClient, conversationId: string,
): Promise<Array<ProposalRowLite & { links: LinkLite[] }>> {
  const { data: rows, error } = await sb
    .from('proposals')
    .select('id, itinerary, total_minor, currency, gate_outcome, review_issues, decision, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const proposals: ProposalRowLite[] = rows.map((r) => ({
    id: r.id as string,
    totalMinor: String(r.total_minor),
    currency: r.currency as string,
    gateOutcome: r.gate_outcome as ProposalRowLite['gateOutcome'],
    reviewIssues: (r.review_issues ?? []) as string[],
    decision: r.decision as 'accept' | 'reject' | null,
    items: itineraryItemsLite(r.itinerary),
  }))

  const acceptedIds = proposals.filter((p) => p.decision === 'accept').map((p) => p.id)
  const linksByProposal = new Map<string, LinkLite[]>()
  if (acceptedIds.length > 0) {
    const { data: links, error: linksError } = await sb
      .from('link_clicks')
      .select('proposal_id, item_id, url, quoted_minor, currency')
      .in('proposal_id', acceptedIds)
    if (linksError) throw linksError
    for (const l of links ?? []) {
      const proposalId = l.proposal_id as string
      const list = linksByProposal.get(proposalId) ?? []
      list.push({
        itemId: l.item_id as string, url: l.url as string,
        quotedMinor: String(l.quoted_minor), currency: l.currency as string,
      })
      linksByProposal.set(proposalId, list)
    }
  }

  return proposals.map((p) => ({ ...p, links: linksByProposal.get(p.id) ?? [] }))
}

/**
 * The swap picker's corpus reads: the newest `tool_results` row per
 * `source_id`, for one conversation and one kind. `tool_results` is
 * append-only (`src/repo/toolResults.ts`'s own doc comment), so a `source_id`
 * can have several rows across separate fetches; `.limit(200)` plus the
 * newest-first ordering bounds the read the same way `listConversations`
 * above bounds its own first-message lookup, and `newestAlternativePerSourceId`
 * does the dedup client-side for the same reason given there: no live test
 * here confirms a PostgREST `distinct on`-equivalent shape, so this takes the
 * flat-query-plus-JS-dedup fallback instead.
 */
export async function loadAlternatives(
  sb: SupabaseClient, conversationId: string, kind: 'flight' | 'hotel',
): Promise<AlternativeLite[]> {
  const { data, error } = await sb
    .from('tool_results')
    .select('source_id, name, price_minor, currency, fetched_at')
    .eq('conversation_id', conversationId)
    .eq('kind', kind)
    .order('fetched_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return newestAlternativePerSourceId(
    (data ?? []) as { source_id: string; name: string; price_minor: string; currency: string; fetched_at: string }[],
  )
}
