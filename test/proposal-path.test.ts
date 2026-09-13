import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { runProposalPath } from '../src/agents/proposalPath.js'
import { recordResults } from '../src/repo/toolResults.js'
import { recordGateResults } from '../src/repo/gateResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { money } from '../src/money.js'
import { emptyNotebook, type Notebook } from '../src/notebook.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const params: FlightSearch = {
  kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
  returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
  cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}
const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdict = (approved: boolean, issues: string[] = []) => ({
  content: [{ type: 'text', text: JSON.stringify({ approved, issues }) }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_r', usage,
})
const withBudget = (nb: Notebook): Notebook =>
  ({ ...nb, budget: { value: money(10_000_00n, 'EUR'), source: 'user', at: NOW.toISOString() } })

async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000b${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                        values (${c!.id}, ${userId}, ${'q' + n}, 'running') returning id`
  const conversationId = c!.id as string, turnId = t!.id as string
  const p = { ...params, flexDays: Number(n) }
  const items = await new MockSupplier({ kind: 'flight', now: () => NOW }).search(p)
  await recordResults(sql, { conversationId, userId, turnId, params: p, items })
  return { userId, conversationId, turnId, items }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })
const refsOf = (s: { items: { sourceId: string }[] }) => [{ sourceId: s.items[0]!.sourceId, quantity: 1, slot: 'outbound' }]

describeDb('proposal path', () => {
  it('gates → reviewer → saved proposal, and the reply carries the proposal id', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const spent = { micros: 0n }
      const create = vi.fn().mockResolvedValue(verdict(true))
      const out = await runProposalPath(deps(sql, create), s, spent,
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [p] = await sql`select id, gate_outcome, review_rounds, parent_proposal_id from proposals where conversation_id = ${s.conversationId}`
      expect(out).toContain(`proposal_id ${p!.id}`)
      expect(out).toMatch(/approved/i)
      expect(p!.gate_outcome).toBe('approved')
      expect(p!.review_rounds).toBe(1)
      expect(spent.micros).toBe(6_000n)
      const rows = await sql`select gate, proposal_id from gate_results where turn_id = ${s.turnId} and round = 0`
      expect(rows).toHaveLength(8)
      expect(rows.every((r) => r.proposal_id === p!.id)).toBe(true)
    })
  })

  it('a gate rejection returns without calling the reviewer or saving anything', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const create = vi.fn()
      const out = await runProposalPath(deps(sql, create), s, { micros: 0n },
        { refs: [{ sourceId: 'INVENTED', quantity: 1, slot: 'outbound' }], notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      expect(out).toMatch(/rejected/i)
      expect(create).not.toHaveBeenCalled()
      expect(await sql`select 1 from proposals where conversation_id = ${s.conversationId}`).toHaveLength(0)
    })
  })

  it('a reviewer rejection below the bound asks for a revision and saves nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const spent = { micros: 0n }
      const out = await runProposalPath(deps(sql, vi.fn().mockResolvedValue(verdict(false, ['stay ends before the return flight']))), s, spent,
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      expect(out).toMatch(/^Revise: stay ends before the return flight/)
      expect(await sql`select 1 from proposals where conversation_id = ${s.conversationId}`).toHaveLength(0)
      expect(spent.micros).toBe(6_000n)
    })
  })

  it('at the bound, a rejection ships UNAPPROVED with the issues on the row and in the reply', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      // Two prior verdicts this turn (rounds 0 and 1) — persisted, not in memory.
      for (const round of [0, 1]) {
        await recordGateResults(sql, { conversationId: s.conversationId, turnId: s.turnId, proposalId: null, round,
          results: [{ gate: 'reviewer', passed: false, detail: 'earlier', sourceIds: [] }] })
      }
      const out = await runProposalPath(deps(sql, vi.fn().mockResolvedValue(verdict(false, ['still wrong']))), s, { micros: 0n },
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 2, parentProposalId: null })
      const [p] = await sql`select gate_outcome, review_rounds, review_issues from proposals where conversation_id = ${s.conversationId}`
      expect(p!.gate_outcome).toBe('shipped_unapproved')
      expect(p!.review_rounds).toBe(3)
      expect(p!.review_issues).toEqual(['still wrong'])
      expect(out).toMatch(/not approved/i)
      expect(out).toContain('still wrong')
    })
  })

  it('a skipped review (ceiling) ships unapproved with the reason recorded', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const out = await runProposalPath(deps(sql, vi.fn()), s, { micros: 0n },
        { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [p] = await sql`select gate_outcome, review_issues from proposals where conversation_id = ${s.conversationId}`
      expect(p!.gate_outcome).toBe('shipped_unapproved')
      expect(p!.review_issues).toEqual(['reviewer skipped: spending limit reached'])
      expect(out).toMatch(/not approved/i)
    })
  })

  it('records the parent on a revision', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const create = vi.fn().mockResolvedValue(verdict(true))
      await runProposalPath(deps(sql, create), s, { micros: 0n }, { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 0, parentProposalId: null })
      const [parent] = await sql`select id from proposals where conversation_id = ${s.conversationId}`
      await runProposalPath(deps(sql, create), s, { micros: 0n }, { refs: refsOf(s), notebook: withBudget(emptyNotebook()), round: 1, parentProposalId: parent!.id })
      const [child] = await sql`select parent_proposal_id from proposals where conversation_id = ${s.conversationId} and parent_proposal_id is not null`
      expect(child!.parent_proposal_id).toBe(parent!.id)
    })
  })
})
