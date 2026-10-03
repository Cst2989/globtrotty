import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAction, describeActionForUi } from '@/src/actions'
import {
  parseResults, parseChoices,
  type ResultsContent, type ChoicesContent, type Filter, type Assumption,
} from '@/src/results'
import { maskUntrustedText } from '@/src/sanitize'

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

/**
 * Plan 5: `results` and `choices` join `action` as roles `loadThread` can see
 * (migration 0018 widens `messages.role`). Both are hydrated server-side by
 * `toThreadView` the same way `action` already is: `results` becomes a fixed
 * one-line marker (ids never reach the RSC payload for this row — the real
 * items reach the browser only through `loadResults`'s own RLS-scoped read
 * of `tool_results`); `choices` is left as its raw JSON, which is already
 * built entirely from our own masked prose plus ids/enums (src/results.ts's
 * own doc comment) and is exactly what `MessageBubble` needs to render the
 * live `ChoiceCard`.
 */
export type ThreadMessage = {
  id: string
  role: 'user' | 'agent' | 'action' | 'results' | 'choices'
  content: string
  created_at: string
}

export type LatestTurn = {
  status: string
  fail_reason: string | null
}

/**
 * One itinerary line, trimmed from `proposals.itinerary` for the card.
 * `dates` (Task 8 review, Minor #9) is a human string built from the stored
 * `detail` — a flight's outbound departure date, and its inbound departure
 * date too when one exists; a hotel's check-in → check-out — or `null` when
 * `detail` does not carry a recognisable shape for its `kind`.
 */
export type ProposalItemLite = {
  slot: string
  sourceId: string
  kind: 'flight' | 'hotel'
  name: string
  priceMinor: string
  currency: string
  fetchedAt: string
  dates: string | null
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

/**
 * One corpus row from `tool_results`, trimmed for the swap picker.
 * `ttlSeconds` travels alongside `fetchedAt` (Task 8 review, Minor #4) so
 * `dropExpiredAlternatives` can filter out ids past their own ttl, and so
 * `SwapPicker` can show each option's own "found N min ago" age — the same
 * information the card already shows for the item it might replace.
 */
export type AlternativeLite = {
  sourceId: string
  name: string
  priceMinor: string
  currency: string
  fetchedAt: string
  ttlSeconds: number
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
/**
 * "10 flights shown" / "1 hotel shown" — the fixed marker a `results` row
 * becomes in the thread. `sourceIds.length` only; nothing about any
 * individual item (price, name) ever reaches this sentence, which is the
 * point: the interactive list lives in `loadResults`'s own RLS-scoped read,
 * never in this server-rendered thread text.
 */
export function describeResultsForUi(r: ResultsContent): string {
  const n = r.sourceIds.length
  const noun = r.kind === 'flights' ? (n === 1 ? 'flight' : 'flights') : (n === 1 ? 'hotel' : 'hotels')
  return `${n} ${noun} shown`
}

export function toThreadView(rows: ThreadMessage[]): ThreadMessage[] {
  return rows.map((r) => {
    if (r.role === 'action') {
      const action = parseAction(r.content)
      return { ...r, content: action ? describeActionForUi(action) : 'A card action was recorded' }
    }
    if (r.role === 'results') {
      const results = parseResults(r.content)
      return { ...r, content: results ? describeResultsForUi(results) : 'Results were recorded' }
    }
    // `choices` passes through unchanged — see this type's own doc comment.
    return r
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
  priceMinor?: unknown; currency?: unknown; fetchedAt?: unknown; detail?: unknown
}
type UnknownRecord = Record<string, unknown>

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null
}

/**
 * Task 8 review, Minor #9. Reads straight off `StoredItineraryItem.detail`
 * (`src/repo/proposals.ts`'s `FlightDetail | HotelDetail`, as jsonb — hence
 * `unknown` here, same posture as `itineraryItemsLite` around it) rather than
 * importing those harness types: this only ever needs three or four string
 * fields, and duplicating that much structural checking is cheaper than
 * trusting a jsonb column's shape at the type level. `departureLocal` is a
 * naive ISO string with no offset (`src/supplier/types.ts`'s own comment) —
 * `.slice(0, 10)` reads its date portion without ever parsing it into a
 * `Date`, which is the one thing this codebase never does to that field.
 * Returns `null` (never throws) when `detail` doesn't carry a recognisable
 * shape for `kind`.
 */
function datesFromDetail(kind: 'flight' | 'hotel', detail: unknown): string | null {
  if (!isRecord(detail)) return null
  if (kind === 'flight') {
    const outbound = detail.outbound
    const inbound = detail.inbound
    const outboundDate = isRecord(outbound) && typeof outbound.departureLocal === 'string'
      ? outbound.departureLocal.slice(0, 10) : null
    if (!outboundDate) return null
    const inboundDate = isRecord(inbound) && typeof inbound.departureLocal === 'string'
      ? inbound.departureLocal.slice(0, 10) : null
    return inboundDate ? `${outboundDate} → ${inboundDate}` : outboundDate
  }
  const { checkIn, checkOut } = detail
  if (typeof checkIn !== 'string' || typeof checkOut !== 'string') return null
  return `${checkIn} → ${checkOut}`
}

/**
 * Trims `proposals.itinerary` (the REHYDRATED snapshot `src/repo/proposals.ts`
 * wrote — never the model's own version, see that module's doc comment) down
 * to the fields the card renders. Never throws: a shape this reader does
 * not recognise (a future schema version, a hand-edited row) yields an empty
 * item list rather than a 500 — the card still shows the total, the gate
 * outcome and the buttons even if an individual line cannot be read.
 */
export function itineraryItemsLite(itinerary: unknown): ProposalItemLite[] {
  const items = (itinerary as StoredItineraryLike | null)?.items
  if (!Array.isArray(items)) return []
  const out: ProposalItemLite[] = []
  for (const raw of items as StoredItineraryItemLike[]) {
    const { slot, sourceId, kind, name, priceMinor, currency, fetchedAt, detail } = raw
    if (
      typeof slot !== 'string' || typeof sourceId !== 'string' || typeof name !== 'string'
      || typeof priceMinor !== 'string' || typeof currency !== 'string' || typeof fetchedAt !== 'string'
      || (kind !== 'flight' && kind !== 'hotel')
    ) continue
    out.push({ slot, sourceId, kind, name, priceMinor, currency, fetchedAt, dates: datesFromDetail(kind, detail) })
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
  rows: { source_id: string; name: string; price_minor: string; currency: string; fetched_at: string; ttl_seconds: number }[],
): AlternativeLite[] {
  const seen = new Set<string>()
  const out: AlternativeLite[] = []
  for (const r of rows) {
    if (seen.has(r.source_id)) continue
    seen.add(r.source_id)
    out.push({
      sourceId: r.source_id, name: r.name, priceMinor: String(r.price_minor),
      currency: r.currency, fetchedAt: r.fetched_at, ttlSeconds: r.ttl_seconds,
    })
  }
  return out
}

/**
 * Fix round 1 (Task 8 review, Minor #4). Same rule `src/repo/toolResults.ts`'s
 * `listExpiredSourceIds` applies for the gate's freshness warning, extracted
 * here as a pure function over the already-trimmed `AlternativeLite` shape so
 * it is testable without a live DB. An id whose newest fetch is already past
 * its own ttl is not a real swap option — offering it would let her pick a
 * price that is already known to be stale.
 */
export function dropExpiredAlternatives(rows: AlternativeLite[], now: Date): AlternativeLite[] {
  return rows.filter((r) => new Date(r.fetchedAt).getTime() + r.ttlSeconds * 1000 >= now.getTime())
}

/**
 * Proposals for one conversation, newest first, itinerary items trimmed via
 * `itineraryItemsLite`. Links are read only for proposals already accepted —
 * spec §2: "After accept, the card shows the links from `link_clicks` as the
 * only anchors on the page" — a decided-`'reject'`-or-undecided proposal
 * gets an empty `links` array rather than a wasted query.
 *
 * Fix round 1 (Task 8 review, Minor #8): `.limit(20)` — a bound in the same
 * spirit as `listConversations`'s `.limit(50)` and `loadThread`'s
 * `.limit(500)` above; a conversation that has been revised dozens of times
 * has no reason to render every superseded card. The `select` names exactly
 * the columns the card uses: `itinerary` is selected WHOLE (never a partial
 * jsonb projection) because `itineraryItemsLite` needs every item's full
 * shape, not a column subset — nothing is dropped from it silently, the
 * trimming happens in that function, after the fetch, not in this query.
 */
export async function loadProposals(
  sb: SupabaseClient, conversationId: string,
): Promise<Array<ProposalRowLite & { links: LinkLite[] }>> {
  const { data: rows, error } = await sb
    .from('proposals')
    .select('id, itinerary, total_minor, currency, gate_outcome, review_issues, decision, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20)
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
 * `source_id`, for one conversation and one kind, with ids past their own
 * ttl dropped. `tool_results` is append-only (`src/repo/toolResults.ts`'s own
 * doc comment), so a `source_id` can have several rows across separate
 * fetches; `.limit(200)` plus the newest-first ordering bounds the read the
 * same way `listConversations` above bounds its own first-message lookup,
 * and `newestAlternativePerSourceId` does the dedup client-side for the same
 * reason given there: no live test here confirms a PostgREST
 * `distinct on`-equivalent shape, so this takes the flat-query-plus-JS-dedup
 * fallback instead.
 *
 * Fix round 1 (Task 8 review, Minor #4): PostgREST cannot filter on
 * `fetched_at + ttl_seconds * interval '1 second' > now()` — a computed
 * comparison across two columns — in its own query-string filter syntax, so
 * `ttl_seconds` is selected alongside `fetched_at` and the expiry check
 * (`dropExpiredAlternatives`) runs in JS after the fetch instead, same as the
 * dedup itself. `now` is injectable for tests; production passes nothing.
 */
export async function loadAlternatives(
  sb: SupabaseClient, conversationId: string, kind: 'flight' | 'hotel', now: Date = new Date(),
): Promise<AlternativeLite[]> {
  const { data, error } = await sb
    .from('tool_results')
    .select('source_id, name, price_minor, currency, fetched_at, ttl_seconds')
    .eq('conversation_id', conversationId)
    .eq('kind', kind)
    .order('fetched_at', { ascending: false })
    .limit(200)
  if (error) throw error
  const deduped = newestAlternativePerSourceId(
    (data ?? []) as { source_id: string; name: string; price_minor: string; currency: string; fetched_at: string; ttl_seconds: number }[],
  )
  return dropExpiredAlternatives(deduped, now)
}

/* ---------- Plan 5: results and choices ---------- */

/**
 * One leg, trimmed from `LegSummary` (src/supplier/types.ts) for the
 * results pane. `via` is the route's intermediate airports — `route` minus
 * its own first and last entries — kept separately from `stops` (a count)
 * because `FlightList`'s "1 stop, DOH" wording needs the airport, not just
 * the number. Every string is run through `maskUntrustedText`: this is
 * supplier-origin data reaching the browser, the same trust boundary
 * `src/sanitize.ts` exists for, even though React's own escaping (this
 * project never renders raw HTML) already makes it safe to render as text —
 * this is defence in depth, not the only guard.
 */
export type LegLite = {
  from: string
  to: string
  departureLocal: string
  arrivalLocal: string
  via: string[]
}

/**
 * One `tool_results` row, trimmed for the results pane. `sourceId` is
 * deliberately NOT masked (unlike every other string here): it round-trips
 * through `onChoose`/`choose`'s `ActionPayload` and the worker's own
 * `rehydrate` (`src/repo/toolResults.ts`), which looks it up by exact
 * equality against `tool_results.source_id` — masking it here would silently
 * break that lookup. The same posture `AlternativeLite` (above) already
 * takes with its own `sourceId`.
 */
export type ResultItemLite = {
  sourceId: string
  name: string
  priceMinor: string
  currency: string
  fetchedAt: string
  ttlSeconds: number
  flight?: {
    outbound: LegLite
    inbound: LegLite | null
    stops: number
    durationMinutes: number
    airlines: string[]
    bags: { cabin: number; checked: number }
    selfTransfer: boolean
  }
  hotel?: {
    rating: number | null
    nights: number
    checkIn: string
    checkOut: string
  }
}

export type ResultsView = {
  messageId: string
  kind: ResultsContent['kind']
  query: ResultsContent['query']
  assumptions: Assumption[]
  filter: Filter | undefined
  items: ResultItemLite[]
}

export type ChoicesView = ChoicesContent & { messageId: string }

type ToolResultRow = {
  source_id: string
  name: string
  price_minor: string
  currency: string
  fetched_at: string
  ttl_seconds: number
  payload: unknown
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? maskUntrustedText(v) : fallback
}

function viaFromRoute(route: unknown): string[] {
  if (!Array.isArray(route) || route.length <= 2) return []
  return route.slice(1, -1).filter((v): v is string => typeof v === 'string').map(maskUntrustedText)
}

/** `null` when `raw` does not carry a recognisable `LegSummary` shape. */
function legLite(raw: unknown): LegLite | null {
  if (!isRecord(raw)) return null
  const { from, to, departureLocal, arrivalLocal, route } = raw
  if (
    typeof from !== 'string' || typeof to !== 'string'
    || typeof departureLocal !== 'string' || typeof arrivalLocal !== 'string'
  ) return null
  return {
    from: maskUntrustedText(from), to: maskUntrustedText(to),
    departureLocal: maskUntrustedText(departureLocal), arrivalLocal: maskUntrustedText(arrivalLocal),
    via: viaFromRoute(route),
  }
}

/** `undefined` when `payload` is not a `FlightDetail` (src/supplier/types.ts) this reader recognises. */
function flightLite(payload: UnknownRecord): ResultItemLite['flight'] | undefined {
  if (payload.kind !== 'flight') return undefined
  const outbound = legLite(payload.outbound)
  if (!outbound) return undefined
  const inbound = payload.inbound === null ? null : legLite(payload.inbound)
  const outboundRaw = isRecord(payload.outbound) ? payload.outbound : {}
  const inboundRaw = isRecord(payload.inbound) ? payload.inbound : {}
  const stops = typeof outboundRaw.stops === 'number' ? outboundRaw.stops : 0
  const carriersOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').map(maskUntrustedText) : []
  const airlines = [...new Set([...carriersOf(outboundRaw.carriers), ...carriersOf(inboundRaw.carriers)])]
  const baggage = isRecord(payload.baggage) ? payload.baggage : {}
  const cabin = typeof baggage.cabinBag === 'number' ? baggage.cabinBag : 0
  const checked = typeof baggage.checkedBag === 'number' ? baggage.checkedBag : 0
  const durationSeconds = typeof payload.totalDurationSeconds === 'number' ? payload.totalDurationSeconds : 0
  return {
    outbound, inbound, stops,
    durationMinutes: Math.round(durationSeconds / 60),
    airlines,
    bags: { cabin, checked },
    selfTransfer: payload.selfTransfer === true,
  }
}

/** `undefined` when `payload` is not a `HotelDetail` (src/supplier/types.ts) this reader recognises. */
function hotelLite(payload: UnknownRecord): ResultItemLite['hotel'] | undefined {
  if (payload.kind !== 'hotel') return undefined
  if (typeof payload.checkIn !== 'string' || typeof payload.checkOut !== 'string') return undefined
  return {
    rating: typeof payload.rating === 'number' ? payload.rating : null,
    nights: typeof payload.nights === 'number' ? payload.nights : 0,
    checkIn: stringOr(payload.checkIn, ''),
    checkOut: stringOr(payload.checkOut, ''),
  }
}

/**
 * `null` when the row's `payload` carries neither a recognisable flight nor
 * hotel shape — a garbled write, never something `recordResults` itself
 * produces. The caller drops a `null` rather than surfacing a broken row.
 */
function toResultItemLite(row: ToolResultRow): ResultItemLite | null {
  if (!isRecord(row.payload)) return null
  const flight = flightLite(row.payload)
  const hotel = hotelLite(row.payload)
  if (!flight && !hotel) return null
  return {
    sourceId: row.source_id,
    name: maskUntrustedText(row.name),
    priceMinor: String(row.price_minor),
    currency: row.currency,
    fetchedAt: row.fetched_at,
    ttlSeconds: row.ttl_seconds,
    ...(flight ? { flight } : {}),
    ...(hotel ? { hotel } : {}),
  }
}

/**
 * Same newest-row-per-`source_id` rule as `newestAlternativePerSourceId`
 * above, extracted so it is testable without a live DB. Correct only when
 * `rows` already arrives newest-first.
 */
export function newestResultItemPerSourceId(rows: ToolResultRow[]): ResultItemLite[] {
  const seen = new Set<string>()
  const out: ResultItemLite[] = []
  for (const r of rows) {
    if (seen.has(r.source_id)) continue
    seen.add(r.source_id)
    const item = toResultItemLite(r)
    if (item) out.push(item)
  }
  return out
}

/** Same rule as `dropExpiredAlternatives` above, over the richer `ResultItemLite` shape. */
export function dropExpiredResultItems(items: ResultItemLite[], now: Date): ResultItemLite[] {
  return items.filter((i) => new Date(i.fetchedAt).getTime() + i.ttlSeconds * 1000 >= now.getTime())
}

/**
 * Every `results` row for one conversation, oldest first, each one's
 * `sourceIds` rehydrated from `tool_results` (newest row per `source_id`,
 * expired ids dropped) into `ResultItemLite`s — the same "newest row per id,
 * then drop what's past its own ttl" shape `loadAlternatives` already uses,
 * just over the richer flight/hotel payload instead of the swap picker's
 * flat name/price. A `sourceId` the corpus no longer has fresh (or never
 * had) is silently absent from that row's `items` rather than throwing.
 *
 * `.limit(50)` on `results` rows and `.limit(500)` on the `tool_results`
 * lookup are the same bounding instinct as `loadThread`/`loadAlternatives`
 * above — a conversation revised many times over has no reason to force an
 * unbounded read.
 */
export async function loadResults(
  sb: SupabaseClient, conversationId: string, now: Date = new Date(),
): Promise<ResultsView[]> {
  const { data: rows, error } = await sb
    .from('messages')
    .select('id, content, created_at')
    .eq('conversation_id', conversationId)
    .eq('role', 'results')
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const parsed = rows
    .map((r) => ({ id: r.id as string, content: parseResults(r.content as string) }))
    .filter((r): r is { id: string; content: ResultsContent } => r.content !== null)
  if (parsed.length === 0) return []

  const allSourceIds = [...new Set(parsed.flatMap((r) => r.content.sourceIds))]

  let bySourceId = new Map<string, ResultItemLite>()
  if (allSourceIds.length > 0) {
    const { data: toolRows, error: toolError } = await sb
      .from('tool_results')
      .select('source_id, name, price_minor, currency, fetched_at, ttl_seconds, payload')
      .eq('conversation_id', conversationId)
      .in('source_id', allSourceIds)
      .order('fetched_at', { ascending: false })
      .limit(500)
    if (toolError) throw toolError
    const deduped = newestResultItemPerSourceId((toolRows ?? []) as ToolResultRow[])
    const fresh = dropExpiredResultItems(deduped, now)
    bySourceId = new Map(fresh.map((i) => [i.sourceId, i]))
  }

  return parsed.map((r) => ({
    messageId: r.id,
    kind: r.content.kind,
    query: r.content.query,
    assumptions: r.content.assumptions,
    filter: r.content.filter,
    items: r.content.sourceIds
      .map((id) => bySourceId.get(id))
      .filter((i): i is ResultItemLite => i !== undefined),
  }))
}

/**
 * The newest `choices` row nothing has answered yet: none of the rows after
 * it is an `action` row parsing to `{ action: 'choice', questionId: <its
 * own questionId> }`. `null` when every `choices` row has a matching answer,
 * or none exist. Scans `choices` rows newest-first and, for each, checks the
 * (already fetched, same bounded read) rows that came after it — cheaper
 * than a second round trip per candidate, and correct regardless of how many
 * `choices` rows this conversation has accumulated.
 */
export async function loadChoices(
  sb: SupabaseClient, conversationId: string,
): Promise<ChoicesView | null> {
  const { data, error } = await sb
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .in('role', ['choices', 'action'])
    .order('created_at', { ascending: true })
    .limit(500)
  if (error) throw error
  const rows = (data ?? []) as { id: string; role: 'choices' | 'action'; content: string; created_at: string }[]

  const choicesRows = rows.filter((r) => r.role === 'choices')
  for (let i = choicesRows.length - 1; i >= 0; i--) {
    const row = choicesRows[i]!
    const parsed = parseChoices(row.content)
    if (!parsed) continue
    const answered = rows.some((r) => {
      if (r.role !== 'action' || r.created_at <= row.created_at) return false
      const action = parseAction(r.content)
      return action?.action === 'choice' && action.questionId === parsed.questionId
    })
    if (!answered) return { ...parsed, messageId: row.id }
  }
  return null
}
