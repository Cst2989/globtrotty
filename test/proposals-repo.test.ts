import { expect, it } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { recordResults } from '../src/repo/toolResults.js'
import { runGates } from '../src/gates/pipeline.js'
import { recordGateResults, attachProposal, countReviewerVerdicts } from '../src/repo/gateResults.js'
import { saveProposal, loadProposal, decideProposal, toStoredItinerary } from '../src/repo/proposals.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook } from '../src/notebook.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-0000000009${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'p' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW })
    .search({ ...params, flexDays: Number(n) })
  await recordResults(sql, { conversationId, userId, turnId, params: { ...params, flexDays: Number(n) }, items })
  const outcome = await runGates(sql, {
    conversationId, turnId, round: 0, now: NOW,
    refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }],
    notebook: { budget: money(10_000_00n, 'EUR'), window: null, currency: 'EUR' },
  })
  if (!outcome.ok) throw new Error('seed: gates rejected')
  return { userId, conversationId, turnId, outcome }
}

describeDb('proposals repo', () => {
  it('saves the REHYDRATED itinerary and attaches the round\'s gate rows', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      const row = await loadProposal(sql, s.conversationId, id)
      expect(row).not.toBeNull()
      expect(row!.itinerary.schemaVersion).toBe(1)
      expect(row!.itinerary.items[0]!.priceMinor).toBe(s.outcome.items[0]!.item.price.minor.toString())
      expect(row!.totalMinor).toBe(s.outcome.total.minor)
      expect(row!.gateOutcome).toBe('approved')
      const attached = await sql<{ n: number }[]>`
        select count(*)::int as n from gate_results
         where turn_id = ${s.turnId} and round = 0 and proposal_id = ${id}`
      expect(attached[0]!.n).toBe(7)
    })
  })

  it('does not attach gate rows from a DIFFERENT round', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      await recordGateResults(sql, { conversationId: s.conversationId, turnId: s.turnId,
        proposalId: null, round: 1, results: [{ gate: 'provenance', passed: true, detail: null, sourceIds: [] }] })
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      const [r1] = await sql`select proposal_id from gate_results where turn_id = ${s.turnId} and round = 1`
      expect(r1!.proposal_id).toBeNull()
      const attached = await sql<{ n: number }[]>`
        select count(*)::int as n from gate_results where proposal_id = ${id}`
      expect(attached[0]!.n).toBe(7)
    })
  })

  it('loads nothing for a proposal from another conversation', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '03'); const b = await seed(sql, '04')
      const id = await saveProposal(sql, {
        conversationId: a.conversationId, userId: a.userId, turnId: a.turnId, round: 0,
        items: a.outcome.items, total: a.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      expect(await loadProposal(sql, b.conversationId, id)).toBeNull()
    })
  })

  it('records an accept with the accepted total copied, once, in this conversation only', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook: emptyNotebook(),
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      await expect(decideProposal(sql, { proposalId: id, conversationId: '00000000-0000-4000-8000-000000000000', decision: 'accept' }))
        .rejects.toThrow(/not found/i)
      await decideProposal(sql, { proposalId: id, conversationId: s.conversationId, decision: 'accept', now: NOW })
      const [row] = await sql`select decision, decided_at, accepted_total_minor, accepted_currency from proposals where id = ${id}`
      expect(row!.decision).toBe('accept')
      expect(BigInt(row!.accepted_total_minor as string)).toBe(s.outcome.total.minor)
      expect(row!.accepted_currency).toBe('EUR')
      expect(new Date(row!.decided_at as Date).toISOString()).toBe(NOW.toISOString())
      await expect(decideProposal(sql, { proposalId: id, conversationId: s.conversationId, decision: 'reject' }))
        .rejects.toThrow(/already decided/i)
    })
  })

  it('counts reviewer verdicts on THIS turn only', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '06'); const b = await seed(sql, '07')
      await recordGateResults(sql, { conversationId: a.conversationId, turnId: a.turnId, proposalId: null, round: 0,
        results: [{ gate: 'reviewer', passed: false, detail: 'no', sourceIds: [] }] })
      await recordGateResults(sql, { conversationId: b.conversationId, turnId: b.turnId, proposalId: null, round: 0,
        results: [{ gate: 'reviewer', passed: true, detail: null, sourceIds: [] }] })
      expect(await countReviewerVerdicts(sql, a.turnId)).toBe(1)
      expect(await countReviewerVerdicts(sql, b.turnId)).toBe(1)
    })
  })

  it('stores the notebook budget so it survives JSON (minor as string)', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      const notebook = {
        ...emptyNotebook(),
        budget: { value: money(10_000_00n, 'EUR'), source: 'user' as const, at: NOW.toISOString() },
      }
      const id = await saveProposal(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, round: 0,
        items: s.outcome.items, total: s.outcome.total, notebook,
        gateOutcome: 'approved', reviewRounds: 1, reviewIssues: [],
        promptVersion: 'driver@2', modelConfigId: 'x', parentProposalId: null,
      })
      const [row] = await sql`select requirements_snapshot from proposals where id = ${id}`
      const snapshot = row!.requirements_snapshot as { budget: { value: { minor: string; currency: string } } }
      expect(snapshot.budget.value.minor).toBe('1000000')
      expect(snapshot.budget.value.currency).toBe('EUR')
    })
  })

  it('serialises money and dates as strings, so the row survives JSON', () => {
    const it0 = {
      ref: { sourceId: 'X', quantity: 1, slot: 'outbound' },
      item: { sourceId: 'X', supplier: 'mock', kind: 'flight' as const, name: 'n',
        price: money(123n, 'EUR'), priceBasis: 'total' as const, fetchedAt: NOW, ttlSeconds: 900,
        bookingUrl: 'https://mock.example/book/X', detail: { kind: 'flight' as const, outbound: { from: 'A', to: 'B', departureLocal: 'x', arrivalLocal: 'y', stops: 0, route: [], cabinClass: 'E', carriers: [], flightNumbers: ['ZZ1'] }, inbound: null, baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 }, totalDurationSeconds: 1, selfTransfer: false },
        searchParams: null },
      lineTotal: money(123n, 'EUR'),
    }
    const out = toStoredItinerary([it0])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(out.items[0]!.priceMinor).toBe('123')
    expect(out.items[0]!.fetchedAt).toBe(NOW.toISOString())
    // F2: bookingUrl must round-trip — the cashier's disclosure path (a
    // supplier that may not requote) needs the ORIGINAL link, not a
    // regenerated one, to build a booking URL from a stored item.
    expect(out.items[0]!.bookingUrl).toBe('https://mock.example/book/X')
  })
})
