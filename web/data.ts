import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAction, describeActionForUi, type ActionPayload } from '@/src/actions'
import {
  parseResults,
  type ResultsContent, type Filter, type Assumption,
} from '@/src/results'
import { maskUntrustedText } from '@/src/sanitize'
import { allowedImageUrl } from '@/src/supplier/searchapi'
import { CODE_MAP } from '@/src/intake/places'
import { airportCity } from '@/src/intake/airports'
import { airlineName } from '@/src/intake/airlines'

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
  // Pass 3: a row written by `handleRefresh` says so, so the thread reads as a
  // history of what happened rather than the same line twice over. The flag is
  // the row's own (`ResultsContent.refreshed`), never inferred from timing.
  return r.refreshed ? `Prices refreshed · ${n} ${noun}` : `${n} ${noun} shown`
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
  /**
   * `via`, as city names — `airportCity` (src/intake/airports.ts) per entry, falling back to the
   * code itself for an airport that table does not know. Resolved here because that table reads
   * `airports.json` off disk at import time and `FlightCard` is a client component. Same length
   * and order as `via`, always, so the two can be read in step.
   */
  viaCities: string[]
  /**
   * This leg's own carrier codes, in the supplier's own order — `LegSummary.carriers`. Kept per
   * leg as well as unioned onto `flight.airlines` (which is what the airline FILTER reads),
   * because a card puts a logo on each leg's own line and the two legs are often flown by
   * different carriers.
   */
  carriers: string[]
  /** `carriers`, as airline names, code as the fallback — same length and order. */
  carrierNames: string[]
  /**
   * This leg's own elapsed time, in minutes.
   *
   * KNOWN LIMIT, and the reason this is computed rather than stored: the supplier gives
   * `totalDurationSeconds` for the WHOLE itinerary and nothing per leg, and `departureLocal`/
   * `arrivalLocal` are naive local times with no offset (see `LegSummary`). So for a one-way —
   * where the one leg IS the itinerary — this is the supplier's own exact figure; for a return
   * trip it is the difference between the two local clocks, which overstates the outbound by
   * the UTC offset between the two cities and understates the inbound by the same amount. The
   * errors cancel in the pair, which is why `flight.durationMinutes` (the itinerary total, from
   * the supplier) is what the Fastest tab sorts on. Fixing the per-leg figure needs a timezone
   * per airport, which no table in this repo carries yet.
   */
  durationMinutes: number
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
  /**
   * Pass 3's bug: `fetchedAt + ttlSeconds` is already in the past. Kiwi
   * flight rows carry `ttl_seconds = 900`, so a page refresh sixteen minutes
   * after a search used to render an EMPTY list under a summary bar and a row
   * of sort tabs — `loadResults` dropped every expired id and nothing said
   * why. The items now survive with this flag instead: the card renders
   * dimmed with its Select disabled, and the pane puts a `Refresh prices`
   * banner above the list. Computed against `loadResults`'s own `now`, so it
   * is a server-render-time answer, never a client clock's.
   */
  expired: boolean
  flight?: {
    outbound: LegLite
    inbound: LegLite | null
    /**
     * The OUTBOUND leg's stops. `FlightList` prints it next to
     * `outbound.via`, so it stays per-leg rather than becoming "the worse
     * leg" — a return flight's connections have no business changing the
     * words under the outbound leg.
     */
    stops: number
    /**
     * The INBOUND leg's stops, or `null` for a one-way. The final review's
     * I3: `web/filters.ts` judged `nonstop`/`maxStops` on the outbound
     * number alone while `src/intake/filter.ts` requires EVERY leg, so
     * clicking "Nonstop" could keep a flight whose return leg has two stops
     * and typing "only direct flights" would then remove it — same ids, two
     * answers. `worstLegStops` (web/filters.ts) is what the filters read.
     */
    inboundStops: number | null
    /** The whole itinerary's duration, the supplier's own figure — what the Fastest tab sorts on. */
    durationMinutes: number
    airlines: string[]
    /**
     * `airlines`, as airline names — `airlineName` (src/intake/airlines.ts) per entry, falling
     * back to the code for a carrier that table does not know. Same length and order as
     * `airlines`, so the card can pair a logo with the name it is the logo OF.
     */
    airlineNames: string[]
    /** `FlightDetail.baggage` — a personal item, a cabin bag and a checked bag, as counts. */
    bags: { personal: number; cabin: number; checked: number }
    selfTransfer: boolean
  }
  /**
   * The hotels pass: everything a Booking-grade card renders (web/components/HotelCard.tsx).
   * Every field mirrors `HotelDetail` (src/supplier/types.ts), where each one's cap and its
   * masking are documented — the adapter is the boundary. This reader still defaults rather
   * than trusts, because a corpus row written before that pass carries none of them.
   */
  hotel?: {
    rating: number | null
    nights: number
    checkIn: string
    checkOut: string
    propertyType: 'hotel' | 'rental' | 'other'
    stars: number | null
    reviews: number | null
    images: string[]
    amenities: string[]
    essentials: string[]
    nearby: { name: string; minutes: number | null; by: string | null }[]
    pricePerNightMinor: string | null
    distanceKm: number | null
  }
}

export type ResultsView = {
  messageId: string
  kind: ResultsContent['kind']
  query: ResultsContent['query']
  assumptions: Assumption[]
  filter: Filter | undefined
  items: ResultItemLite[]
  /**
   * The newest item's `fetchedAt`, or `null` for a row that resolved to no
   * items at all — what the stale banner's "These prices are from 2 h ago."
   * is computed from. See `freshnessOf`.
   */
  fetchedAt: string | null
  /** True once any item in this row is past its own ttl — the banner's one condition. */
  stale: boolean
  /**
   * Place-table city names for every metro code this row names — `query.from`, `query.to`, and
   * any place-code assumption value. Resolved HERE, server-side, because
   * `src/intake/places.ts` reads `places.json` off disk at import time and the components that
   * render this (`SummaryBar` under `ResultsPane`) are client components that only ever import
   * `web/data.ts` for its types.
   *
   * A code the table does not know is simply absent, and the renderer falls back to the code —
   * the same posture `placeLabel` (src/agents/intake.ts) already takes.
   */
  cityNames: Record<string, string>
}

/**
 * The city names a `results` row needs to render its summary bar and its assumption line. Pure
 * and exported so `test/web-data.test.ts` can pin which codes get resolved without a live DB.
 */
export function cityNamesFor(content: ResultsContent): Record<string, string> {
  const codes = [
    content.query.from,
    content.query.to,
    // `assumptions` is the only other place a bare metro code travels: `assembleBrief` writes
    // `{ field: 'origin', value: <code> }` when it defaulted the origin to her last one.
    ...content.assumptions.filter((a) => a.field === 'origin').map((a) => a.value),
  ]
  const out: Record<string, string> = {}
  for (const code of codes) {
    if (!code) continue
    const place = CODE_MAP.get(code)
    if (place) out[code] = place.city
  }
  return out
}


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

/** A `LegSummary.carriers` array, masked — supplier-origin strings, same boundary as every other. */
function carriersOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').map(maskUntrustedText) : []
}

/**
 * Minutes between two naive local ISO date-times, read field by field so neither is ever parsed
 * as a zoned `Date` (the rule this codebase applies to every supplier timestamp). Negative
 * differences clamp to 0 — a garbled pair is not a negative flight.
 */
export function naiveMinutesBetween(fromIso: string, toIso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  const a = m.exec(fromIso)
  const b = m.exec(toIso)
  if (!a || !b) return 0
  const at = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]), Number(a[4]), Number(a[5]))
  const bt = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]), Number(b[4]), Number(b[5]))
  return Math.max(0, Math.round((bt - at) / 60_000))
}

/**
 * `null` when `raw` does not carry a recognisable `LegSummary` shape.
 *
 * `exactMinutes` is the supplier's own itinerary duration, passed only when this leg IS the whole
 * itinerary (a one-way) — see `LegLite.durationMinutes` for why the computed figure is otherwise
 * the best available.
 */
function legLite(raw: unknown, exactMinutes: number | null): LegLite | null {
  if (!isRecord(raw)) return null
  const { from, to, departureLocal, arrivalLocal, route } = raw
  if (
    typeof from !== 'string' || typeof to !== 'string'
    || typeof departureLocal !== 'string' || typeof arrivalLocal !== 'string'
  ) return null
  const via = viaFromRoute(route)
  const carriers = carriersOf(raw.carriers)
  return {
    from: maskUntrustedText(from), to: maskUntrustedText(to),
    departureLocal: maskUntrustedText(departureLocal), arrivalLocal: maskUntrustedText(arrivalLocal),
    via,
    viaCities: via.map((code) => airportCity(code) ?? code),
    carriers,
    carrierNames: carriers.map((code) => airlineName(code) ?? code),
    durationMinutes: exactMinutes ?? naiveMinutesBetween(departureLocal, arrivalLocal),
  }
}

/** `undefined` when `payload` is not a `FlightDetail` (src/supplier/types.ts) this reader recognises. */
function flightLite(payload: UnknownRecord): ResultItemLite['flight'] | undefined {
  if (payload.kind !== 'flight') return undefined
  const durationSeconds = typeof payload.totalDurationSeconds === 'number' ? payload.totalDurationSeconds : 0
  const durationMinutes = Math.round(durationSeconds / 60)
  const oneWay = payload.inbound === null
  const outbound = legLite(payload.outbound, oneWay ? durationMinutes : null)
  if (!outbound) return undefined
  const inbound = oneWay ? null : legLite(payload.inbound, null)
  const outboundRaw = isRecord(payload.outbound) ? payload.outbound : {}
  const inboundRaw = isRecord(payload.inbound) ? payload.inbound : {}
  const stops = typeof outboundRaw.stops === 'number' ? outboundRaw.stops : 0
  // `null` for a one-way; 0 for a return leg whose payload has no readable
  // `stops` — the same fail-permissive default as the outbound above, and the
  // same one `src/intake/filter.ts` gets for free by reading a typed
  // `LegSummary`.
  const inboundStops = payload.inbound === null
    ? null
    : (typeof inboundRaw.stops === 'number' ? inboundRaw.stops : 0)
  const airlines = [...new Set([...outbound.carriers, ...(inbound?.carriers ?? [])])]
  const baggage = isRecord(payload.baggage) ? payload.baggage : {}
  const personal = typeof baggage.personalItem === 'number' ? baggage.personalItem : 0
  const cabin = typeof baggage.cabinBag === 'number' ? baggage.cabinBag : 0
  const checked = typeof baggage.checkedBag === 'number' ? baggage.checkedBag : 0
  return {
    outbound, inbound, stops, inboundStops,
    durationMinutes,
    airlines,
    airlineNames: airlines.map((code) => airlineName(code) ?? code),
    bags: { personal, cabin, checked },
    selfTransfer: payload.selfTransfer === true,
  }
}

/** A number in `[0, max]` off an unknown payload field, else null. */
function numberOr(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value >= 0 && value <= max ? value : null
}

/** A capped list of masked strings off an unknown payload field. */
function stringsOf(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').slice(0, cap).map(maskUntrustedText)
}

/**
 * The photo URLs a card may render, host-checked a SECOND time.
 *
 * `allowedImageUrl` already ran at the adapter boundary, so every URL in a row this office
 * wrote is on the allowlist. It runs again here because this is the step that puts a string
 * into an `<img src>`, and the corpus is a database that outlives the code that filled it —
 * a row from a future bypass insert, a restore, or an adapter that regressed does not get to
 * reach the browser on the strength of having once been checked.
 */
function imagesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && allowedImageUrl(v))
    .slice(0, 5)
}

/** `undefined` when `payload` is not a `HotelDetail` (src/supplier/types.ts) this reader recognises. */
function hotelLite(payload: UnknownRecord): ResultItemLite['hotel'] | undefined {
  if (payload.kind !== 'hotel') return undefined
  if (typeof payload.checkIn !== 'string' || typeof payload.checkOut !== 'string') return undefined
  const nearby = Array.isArray(payload.nearby) ? payload.nearby : []
  return {
    rating: numberOr(payload.rating, 5),
    nights: typeof payload.nights === 'number' ? payload.nights : 0,
    checkIn: stringOr(payload.checkIn, ''),
    checkOut: stringOr(payload.checkOut, ''),
    // An unknown value reads as `'other'`, which renders no type label at all — the same
    // posture `propertyTypeOf` takes at the adapter.
    propertyType: payload.propertyType === 'hotel' || payload.propertyType === 'rental'
      ? payload.propertyType
      : 'other',
    stars: numberOr(payload.stars, 5),
    reviews: numberOr(payload.reviews, Number.MAX_SAFE_INTEGER),
    images: imagesOf(payload.images),
    amenities: stringsOf(payload.amenities, 12),
    essentials: stringsOf(payload.essentials, 6),
    nearby: nearby.slice(0, 3).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return []
      return [{
        name: maskUntrustedText(entry.name),
        minutes: numberOr(entry.minutes, 100_000),
        by: typeof entry.by === 'string' ? maskUntrustedText(entry.by) : null,
      }]
    }),
    // A decimal-digit string or nothing: this goes through `BigInt()` in the renderer, which
    // throws on anything else.
    pricePerNightMinor: typeof payload.pricePerNightMinor === 'string' && /^\d{1,18}$/.test(payload.pricePerNightMinor)
      ? payload.pricePerNightMinor
      : null,
    distanceKm: numberOr(payload.distanceKm, 100_000),
  }
}

/**
 * `null` when the row's `payload` carries neither a recognisable flight nor
 * hotel shape — a garbled write, never something `recordResults` itself
 * produces. The caller drops a `null` rather than surfacing a broken row.
 */
function toResultItemLite(row: ToolResultRow, now: Date): ResultItemLite | null {
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
    expired: isExpired(row.fetched_at, row.ttl_seconds, now),
    ...(flight ? { flight } : {}),
    ...(hotel ? { hotel } : {}),
  }
}

/**
 * The same boundary rule `dropExpiredAlternatives` applies (`>= now` counts
 * as still fresh), now kept as a FLAG rather than a filter for result items —
 * see `ResultItemLite.expired`. The swap picker's own `AlternativeLite` still
 * filters: an alternative whose price has expired is an offer this office
 * cannot stand behind, and there is no Refresh button on that card to make it
 * good again.
 */
export function isExpired(fetchedAt: string, ttlSeconds: number, now: Date): boolean {
  return new Date(fetchedAt).getTime() + ttlSeconds * 1000 < now.getTime()
}

/**
 * Same newest-row-per-`source_id` rule as `newestAlternativePerSourceId`
 * above, extracted so it is testable without a live DB. Correct only when
 * `rows` already arrives newest-first.
 */
export function newestResultItemPerSourceId(rows: ToolResultRow[], now: Date): ResultItemLite[] {
  const seen = new Set<string>()
  const out: ResultItemLite[] = []
  for (const r of rows) {
    if (seen.has(r.source_id)) continue
    seen.add(r.source_id)
    const item = toResultItemLite(r, now)
    if (item) out.push(item)
  }
  return out
}

/**
 * A `results` row's own freshness, from the items it actually resolved to:
 * `fetchedAt` is the NEWEST item's (they are written by one search, so they
 * normally share it to the millisecond), and `stale` is true as soon as any
 * one of them is past its ttl. Any, not all: a row half of whose prices can
 * no longer be stood behind is a row worth re-running, and the banner's
 * offer ("Refresh prices") re-runs the whole search either way.
 *
 * Pure and exported so `test/web-data.test.ts` pins it without a live DB.
 */
export function freshnessOf(items: ResultItemLite[]): { fetchedAt: string | null; stale: boolean } {
  let fetchedAt: string | null = null
  for (const i of items) {
    if (fetchedAt === null || i.fetchedAt > fetchedAt) fetchedAt = i.fetchedAt
  }
  return { fetchedAt, stale: items.some((i) => i.expired) }
}

/**
 * Every `results` row for one conversation, oldest first, each one's
 * `sourceIds` rehydrated from `tool_results` (newest row per `source_id`)
 * into `ResultItemLite`s. A `sourceId` the corpus never had is silently
 * absent from that row's `items` rather than throwing.
 *
 * Pass 3's bug: this used to drop every id past its own ttl, exactly as
 * `loadAlternatives` still does. Kiwi flight rows carry `ttl_seconds = 900`,
 * so a page refresh a quarter of an hour after a search rendered an empty
 * list under a full summary bar and a row of sort tabs, with nothing on
 * screen saying the prices had simply aged out. Expired items are KEPT here
 * and flagged (`ResultItemLite.expired`, `ResultsView.stale`); the pane dims
 * them, disables their Select, and offers "Refresh prices", which re-runs
 * the stored search (src/agents/refresh.ts). The guarantee that matters —
 * never letting her ACT on an expired price — is unchanged, and the freshness
 * gate (src/gates/freshnessGate.ts) remains the one that enforces it.
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
    const deduped = newestResultItemPerSourceId((toolRows ?? []) as ToolResultRow[], now)
    bySourceId = new Map(deduped.map((i) => [i.sourceId, i]))
  }

  return parsed.map((r) => {
    const items = r.content.sourceIds
      .map((id) => bySourceId.get(id))
      .filter((i): i is ResultItemLite => i !== undefined)
    return {
      messageId: r.id,
      kind: r.content.kind,
      query: r.content.query,
      assumptions: r.content.assumptions,
      filter: r.content.filter,
      items,
      ...freshnessOf(items),
      cityNames: cityNamesFor(r.content),
    }
  })
}

/* ---------- Results UI pass 2 (E): the skeleton's own two inputs ---------- */

/**
 * The newest `action` row's own two enum fields, or `null` when the conversation has none.
 *
 * Only the action NAME and (for a `choose`) its kind cross the server boundary — never the
 * `sourceId`/`proposalId` the row also carries, the same posture `toThreadView` takes for the
 * sentence it renders an action row as.
 */
export type LatestAction = { action: string; kind: 'flight' | 'hotel' | null }

/** The two actions whose own `kind` the skeleton needs; every other one has none to carry. */
function kindOf(action: ActionPayload): 'flight' | 'hotel' | null {
  return action.action === 'choose' || action.action === 'refresh' ? action.kind : null
}

export async function loadLatestAction(
  sb: SupabaseClient, conversationId: string,
): Promise<LatestAction | null> {
  const { data: rows, error } = await sb
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'action')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const content = rows?.[0]?.content as string | undefined
  if (content === undefined) return null
  const action = parseAction(content)
  if (!action) return null
  return { action: action.action, kind: kindOf(action) }
}

/**
 * Which skeleton the results pane should show, if any:
 *
 * - `'full'` — the whole pane, because a search is running and there is nothing yet. This is also
 *   what makes the page render the split at all on a conversation with no `results` row, so the
 *   layout does not jump from one column to two when the first row lands.
 * - `'hotels'` — a hotel skeleton ABOVE the flights she already has, because she just chose a
 *   flight and `handleChooseFlight` is off searching stays. The flights list stays where it is;
 *   only the thing being fetched is a placeholder.
 * - `null` — nothing is running, or something is running that the pane has no shape to promise
 *   (a question for the driver, a typed filter, which both answer in the thread).
 *
 * Pass 3 (section 1e) adds the `refresh` action, which is a search like any other and so gets
 * the same two shapes: refreshing FLIGHTS replaces the pane (the whole list is about to be
 * rewritten with new prices), refreshing HOTELS puts the hotel placeholder above what she has.
 *
 * Pure, so `test/web-data.test.ts` pins every branch without a live DB.
 */
export type SkeletonMode = 'full' | 'hotels' | null

export function skeletonMode(input: {
  /** `conversations.status`. */
  status: string
  /** Every `results` row's kind, oldest first — the order `loadResults` returns. */
  resultKinds: ResultsContent['kind'][]
  latestAction: LatestAction | null
}): SkeletonMode {
  if (input.status !== 'working') return null
  if (input.resultKinds.length === 0) return 'full'
  const action = input.latestAction
  if (action?.action === 'refresh') return action.kind === 'hotel' ? 'hotels' : 'full'
  const newest = input.resultKinds[input.resultKinds.length - 1]
  const choseFlight = action?.action === 'choose' && action.kind === 'flight'
  return newest === 'flights' && choseFlight ? 'hotels' : null
}
