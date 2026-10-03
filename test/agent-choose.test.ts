import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { handleChoose } from '../src/agents/choose.js'
import { applyRequirementsPatch } from '../src/repo/notebook.js'
import { recordResults } from '../src/repo/toolResults.js'
import { loadNewestProposalForTurn } from '../src/repo/proposals.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const approve = () => ({
  content: [{ type: 'text', text: JSON.stringify({ approved: true, issues: [] }) }],
  stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r', usage,
})

const flightParams: FlightSearch = {
  kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: '2026-12-06',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'PremiumEconomy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

type Seeded = { userId: string; conversationId: string; turnId: string }

/** A fresh conversation at the planning desk, with a notebook already carrying the destination
 * and party size a chosen flight's hotel search reads. `n` keys the user id so parallel `it`
 * blocks never collide on the same row. */
async function seed(sql: postgres.Sql, n: string): Promise<Seeded> {
  const userId = `00000000-0000-4000-8000-0000000c10${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const conversationId = c!.id as string
  await applyRequirementsPatch(sql, {
    conversationId, userId, source: 'user',
    patch: {
      destination: 'TYO', originCity: 'BCN', departureDate: '2026-11-19', returnDate: '2026-12-06',
      partySize: { adults: 2, children: 0, infants: 0 },
    },
  })
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${c!.id}, ${userId}, ${'ch' + n}, 'running') returning id`
  return { userId, conversationId, turnId: t!.id as string }
}

/** A second fresh turn for the same conversation — the seeded turn above must be 'done' first,
 * same reasoning as test/web-api-proposals.test.ts's own seed (`turns_one_active_per_conversation`). */
async function nextTurn(sql: postgres.Sql, s: Seeded, n: string): Promise<Seeded> {
  await sql`update turns set status = 'done' where id = ${s.turnId}`
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${s.conversationId}, ${s.userId}, ${'ch2-' + n}, 'running') returning id`
  return { ...s, turnId: t!.id as string }
}

function ctx(s: Seeded) {
  return { conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, state: { step: 0, messages: [] } }
}

function makeDeps(sql: postgres.Sql, create: (r: unknown) => Promise<unknown>, hotels: MockSupplier) {
  return {
    sql, transport: { create }, flights: new MockSupplier({ kind: 'flight', now: () => NOW }), hotels,
    limits: DEFAULT_LIMITS, now: () => NOW.getTime(), notifier: new LogNotifier(() => {}),
    jev: { apiKey: 'test-key' },
  }
}

describeDb('handleChoose', () => {
  it('choosing a flight accepts a flights-only proposal and searches hotels for the chosen window', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const flightSupplier = new MockSupplier({ kind: 'flight', now: () => NOW })
      const flightItems = await flightSupplier.search(flightParams)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: flightParams, items: flightItems,
      })

      const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
      const searchSpy = vi.spyOn(hotels, 'search')
      const create = vi.fn().mockResolvedValue(approve())
      const deps = makeDeps(sql, create, hotels)

      const step = await handleChoose(deps, ctx(s), { kind: 'flight', sourceId: flightItems[0]!.sourceId })

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Flight noted. Here are hotels in Tokyo for 19 Nov to 6 Dec.')
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy.mock.calls[0]![0]).toMatchObject({
        kind: 'hotel', query: 'Tokyo', checkIn: '2026-11-19', checkOut: '2026-12-06', adults: 2,
      })

      expect(step.attachments).toHaveLength(1)
      const attachment = step.attachments![0]!
      expect(attachment.role).toBe('results')
      const content = attachment.content as { kind: string; sourceIds: string[] }
      expect(content.kind).toBe('hotels')
      expect(content.sourceIds.length).toBeGreaterThan(0)

      const proposals = await sql<{ id: string; decision: string | null; itinerary: { items: { slot: string }[] } }[]>`
        select id, decision, itinerary from proposals where conversation_id = ${s.conversationId}`
      expect(proposals).toHaveLength(1)
      expect(proposals[0]!.decision).toBe('accept')
      expect(proposals[0]!.itinerary.items).toHaveLength(1)
      expect(proposals[0]!.itinerary.items[0]!.slot).toBe('flight')

      // Every hotel id in the attachment is actually in the corpus for this conversation.
      const hotelRows = await sql`
        select source_id from tool_results where conversation_id = ${s.conversationId} and kind = 'hotel'`
      expect(hotelRows.map((r) => r.source_id).sort()).toEqual([...content.sourceIds].sort())
    })
  })

  it('choosing a hotel afterwards records the combined proposal through the gates and reviewer, UNDECIDED', async () => {
    await withTestDb(async (sql) => {
      const s0 = await seed(sql, '02')
      const flightSupplier = new MockSupplier({ kind: 'flight', now: () => NOW })
      const flightItems = await flightSupplier.search(flightParams)
      await recordResults(sql, {
        conversationId: s0.conversationId, userId: s0.userId, turnId: s0.turnId, params: flightParams, items: flightItems,
      })

      const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
      const create = vi.fn().mockResolvedValue(approve())
      const flightStep = await handleChoose(
        makeDeps(sql, create, hotels), ctx(s0), { kind: 'flight', sourceId: flightItems[0]!.sourceId },
      )
      if (flightStep.kind !== 'park') throw new Error('unreachable')
      const hotelSourceIds = (flightStep.attachments![0]!.content as { sourceIds: string[] }).sourceIds

      const s1 = await nextTurn(sql, s0, '02')
      const hotelStep = await handleChoose(
        makeDeps(sql, create, hotels), ctx(s1), { kind: 'hotel', sourceId: hotelSourceIds[0]! },
      )

      expect(hotelStep.kind).toBe('park')
      if (hotelStep.kind !== 'park') throw new Error('unreachable')
      expect(hotelStep.message).toBe('Trip summary ready. Use "Get booking links" when you want to book.')
      expect(hotelStep.attachments).toBeUndefined()

      const allProposals = await sql`select 1 from proposals where conversation_id = ${s0.conversationId}`
      expect(allProposals).toHaveLength(2)

      // Scoped to the HOTEL turn's own saved row, never ordered by `created_at`
      // (frozen inside `withTestDb`'s transaction — see test/helpers/db.ts).
      const saved = await loadNewestProposalForTurn(sql, s1.turnId)
      expect(saved).not.toBeNull()
      const [combined] = await sql<{ decision: string | null; itinerary: { items: { slot: string }[] } }[]>`
        select decision, itinerary from proposals where id = ${saved!.id}`
      // C4: the combined proposal stays UNDECIDED. `PinnedSummary` renders "Get booking links"
      // only while `decision === null`, and `/decide` is what queues the `hand_off` action the
      // cashier needs to mint links — accepting here made the whole hand-off unreachable.
      expect(combined!.decision).toBeNull()
      expect(combined!.itinerary.items.map((i) => i.slot).sort()).toEqual(['flight', 'stay'])

      // The FLIGHTS-ONLY proposal stays accepted: `loadNewestAcceptedItinerary` is how the
      // hotel turn recovers the flight half, and it reads only accepted rows.
      const flightsOnly = await loadNewestProposalForTurn(sql, s0.turnId)
      const [flightProposal] = await sql<{ decision: string | null }[]>`
        select decision from proposals where id = ${flightsOnly!.id}`
      expect(flightProposal!.decision).toBe('accept')

      const gateRows = await sql`
        select gate from gate_results where turn_id = ${s1.turnId} and round = 0`
      expect(gateRows.length).toBeGreaterThan(0)
      expect(gateRows.every((r) => typeof r.gate === 'string')).toBe(true)
    })
  })

  it('a gate rejection leaves no proposal row and returns the fixed message', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const flightSupplier = new MockSupplier({ kind: 'flight', now: () => NOW })
      const flightItems = await flightSupplier.search(flightParams)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params: flightParams, items: flightItems,
      })
      // Force a freshness violation: the stored row is already past its own ttl.
      await sql`update tool_results set fetched_at = fetched_at - interval '1 day', ttl_seconds = 1
                 where conversation_id = ${s.conversationId}`

      const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
      const create = vi.fn()
      const step = await handleChoose(
        makeDeps(sql, create, hotels), ctx(s), { kind: 'flight', sourceId: flightItems[0]!.sourceId },
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('That option no longer passes our checks (price moved or expired). Pick another.')
      expect(step.attachments).toBeUndefined()
      expect(create).not.toHaveBeenCalled()

      const proposals = await sql`select 1 from proposals where conversation_id = ${s.conversationId}`
      expect(proposals).toHaveLength(0)
    })
  })

  it('choosing a hotel with no prior accepted flight is refused without touching the gates', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
      const hotelItems = await hotels.search({
        kind: 'hotel', query: 'Tokyo', checkIn: '2026-11-19', checkOut: '2026-12-06', adults: 2, currency: 'EUR',
      })
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
        params: { kind: 'hotel', query: 'Tokyo', checkIn: '2026-11-19', checkOut: '2026-12-06', adults: 2, currency: 'EUR' },
        items: hotelItems,
      })
      const create = vi.fn()
      const step = await handleChoose(
        makeDeps(sql, create, hotels), ctx(s), { kind: 'hotel', sourceId: hotelItems[0]!.sourceId },
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Choose a flight first, then a hotel.')
      expect(create).not.toHaveBeenCalled()
      const proposals = await sql`select 1 from proposals where conversation_id = ${s.conversationId}`
      expect(proposals).toHaveLength(0)
    })
  })

  it('an unknown sourceId is refused without reaching the gates', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      const hotels = new MockSupplier({ kind: 'hotel', now: () => NOW })
      const create = vi.fn()
      const step = await handleChoose(
        makeDeps(sql, create, hotels), ctx(s), { kind: 'flight', sourceId: 'MOCK-flight-does-not-exist' },
      )
      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('That flight is no longer available. Pick another.')
      expect(create).not.toHaveBeenCalled()
    })
  })
})
