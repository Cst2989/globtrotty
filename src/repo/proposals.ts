import type postgres from 'postgres'
import type { RehydratedItem } from '../gates/types.js'
import type { Money } from '../money.js'
import type { Notebook } from '../notebook.js'
import { notebookToStored } from './notebook.js'
import type { FlightDetail, HotelDetail, SearchParams } from '../supplier/types.js'
import { attachProposal } from './gateResults.js'

export type StoredItineraryItem = {
  slot: string; quantity: number
  sourceId: string; supplier: string; kind: 'flight' | 'hotel'; name: string
  priceMinor: string; currency: string; priceBasis: 'total' | 'pre_tax'
  fetchedAt: string
  lineTotalMinor: string
  bookingUrl: string | null
  detail: FlightDetail | HotelDetail
  searchParams: SearchParams | null
}
export type StoredItinerary = { schemaVersion: 1; items: StoredItineraryItem[] }
export type GateOutcomeLabel = 'approved' | 'shipped_unapproved'

export type ProposalRow = {
  id: string; conversationId: string; userId: string; turnId: string | null
  itinerary: StoredItinerary; totalMinor: bigint; currency: string
  gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
  decision: 'accept' | 'reject' | null; decidedAt: Date | null
  parentProposalId: string | null; createdAt: Date
}

/**
 * The itinerary column holds what the GATES returned, never what the model
 * sent. Money and dates are strings: `bigint` and `Date` do not survive
 * `JSON.stringify`, and `sql.json` would throw on the former. Version 1;
 * `itinerary_schema_version` on the row carries the same number so a reader
 * can refuse a shape it does not know.
 */
export function toStoredItinerary(items: RehydratedItem[]): StoredItinerary {
  return {
    schemaVersion: 1,
    items: items.map(({ ref, item, lineTotal }) => ({
      slot: ref.slot, quantity: ref.quantity,
      sourceId: item.sourceId, supplier: item.supplier, kind: item.kind, name: item.name,
      priceMinor: item.price.minor.toString(), currency: item.price.currency,
      priceBasis: item.priceBasis, fetchedAt: item.fetchedAt.toISOString(),
      lineTotalMinor: lineTotal.minor.toString(),
      bookingUrl: item.bookingUrl,
      detail: item.detail, searchParams: item.searchParams,
    })),
  }
}

export async function saveProposal(
  sql: postgres.Sql,
  args: {
    conversationId: string; userId: string; turnId: string | null; round: number
    items: RehydratedItem[]; total: Money; notebook: Notebook
    gateOutcome: GateOutcomeLabel; reviewRounds: number; reviewIssues: string[]
    promptVersion: string; modelConfigId: string; parentProposalId: string | null
  },
): Promise<string> {
  const itinerary = toStoredItinerary(args.items)
  // `notebookToStored`, not `sql.json(args.notebook)`: `Notebook.budget.value.minor`
  // is a `bigint`, and `JSON.stringify` (which `sql.json` calls under the hood)
  // throws on one. `src/repo/notebook.ts` already solved this for
  // `conversations.requirements`; this reuses that exact serialisation so the
  // snapshot round-trips through `money()` the same way the live notebook does.
  const [row] = await sql<{ id: string }[]>`
    insert into proposals
      (conversation_id, user_id, turn_id, itinerary, itinerary_schema_version,
       requirements_snapshot, total_minor, currency, gate_outcome, review_rounds,
       review_issues, prompt_version, model_config_id, parent_proposal_id)
    values
      (${args.conversationId}, ${args.userId}, ${args.turnId}, ${sql.json(itinerary as never)}, 1,
       ${sql.json(notebookToStored(args.notebook) as never)}, ${args.total.minor.toString()}, ${args.total.currency},
       ${args.gateOutcome}, ${args.reviewRounds}, ${sql.json(args.reviewIssues as never)},
       ${args.promptVersion}, ${args.modelConfigId}, ${args.parentProposalId})
    returning id`
  const id = row!.id
  if (args.turnId !== null) await attachProposal(sql, { turnId: args.turnId, round: args.round, proposalId: id })
  return id
}

type Row = {
  id: string; conversation_id: string; user_id: string; turn_id: string | null
  itinerary: StoredItinerary; total_minor: string; currency: string
  gate_outcome: GateOutcomeLabel; review_rounds: number; review_issues: string[]
  decision: 'accept' | 'reject' | null; decided_at: Date | null
  parent_proposal_id: string | null; created_at: Date
}

/** Scoped to the conversation: a proposal id from another conversation is "not found", never "forbidden". */
export async function loadProposal(
  sql: postgres.Sql, conversationId: string, proposalId: string,
): Promise<ProposalRow | null> {
  const rows = await sql<Row[]>`
    select id, conversation_id, user_id, turn_id, itinerary, total_minor, currency,
           gate_outcome, review_rounds, review_issues, decision, decided_at,
           parent_proposal_id, created_at
      from proposals where id = ${proposalId} and conversation_id = ${conversationId}`
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id, conversationId: r.conversation_id, userId: r.user_id, turnId: r.turn_id,
    itinerary: r.itinerary, totalMinor: BigInt(r.total_minor), currency: r.currency,
    gateOutcome: r.gate_outcome, reviewRounds: r.review_rounds, reviewIssues: r.review_issues,
    decision: r.decision, decidedAt: r.decided_at, parentProposalId: r.parent_proposal_id,
    createdAt: r.created_at,
  }
}

/**
 * Her decision, recorded once. Not a tool: the plan 4 route handler and the
 * demo both call this, so the cashier's 30-minute window has one clock.
 * `now` is injectable for tests; production passes nothing.
 */
export async function decideProposal(
  sql: postgres.Sql,
  args: {
    proposalId: string; conversationId: string
    decision: 'accept' | 'reject'; rejectReason?: string | null; now?: Date
  },
): Promise<void> {
  const now = args.now ?? new Date()
  const rows = await sql<{ decision: string | null }[]>`
    select decision from proposals where id = ${args.proposalId} and conversation_id = ${args.conversationId}`
  if (rows.length === 0) throw new Error(`decideProposal: proposal ${args.proposalId} not found in this conversation`)
  if (rows[0]!.decision !== null) throw new Error(`decideProposal: proposal ${args.proposalId} already decided`)
  const updated = await sql`
    update proposals
       set decision = ${args.decision}, decided_at = ${now}, reject_reason = ${args.rejectReason ?? null},
           accepted_total_minor = case when ${args.decision} = 'accept' then total_minor else null end,
           accepted_currency    = case when ${args.decision} = 'accept' then currency else null end
     where id = ${args.proposalId} and conversation_id = ${args.conversationId} and decision is null
    returning id`
  if (updated.length === 0) throw new Error(`decideProposal: proposal ${args.proposalId} already decided`)
}
