import { describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeRouter, routeMessage } from '../src/agents/router.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { money } from '../src/money.js'
import type { SupplierItem } from '../src/supplier/types.js'
import type { ResultsContent } from '../src/results.js'
import type { ActionPayload } from '../src/actions.js'

type Seeded = { userId: string; conversationId: string; turnId: string }

async function seedConversation(sql: postgres.Sql, n: string, desk: 'front' | 'planning' = 'planning'): Promise<Seeded> {
  const userId = `00000000-0000-4000-8000-00000000a0${n}`
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, ${desk}) returning id`
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${c!.id}, ${userId}, ${'rt' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}

/** Plain `now()` inserts — fine wherever this test never relies on created_at order between two
 * rows of the same role. Where it does (the action-dispatch tests), `clock_timestamp()` is used
 * explicitly, the same way src/handler.ts's own `submitAction` orders a userNote ahead of its
 * action row. */
async function insertMessage(
  sql: postgres.Sql, s: Seeded, role: 'user' | 'results' | 'action', content: string, clock = false,
) {
  if (clock) {
    await sql`insert into messages (conversation_id, user_id, role, content, created_at)
              values (${s.conversationId}, ${s.userId}, ${role}, ${content}, clock_timestamp())`
  } else {
    await sql`insert into messages (conversation_id, user_id, role, content)
              values (${s.conversationId}, ${s.userId}, ${role}, ${content})`
  }
}

function ctx(s: Seeded, text: string) {
  return {
    conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
    state: { step: 0, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] },
  }
}

function deps(sql: postgres.Sql, fetchImpl: ReturnType<typeof vi.fn>, create: (r: unknown) => Promise<unknown>, flights: MockSupplier) {
  return {
    sql, transport: { create }, flights, hotels: new MockSupplier({ kind: 'hotel' }),
    limits: DEFAULT_LIMITS, now: () => Date.now(), notifier: new LogNotifier(() => {}),
    jev: { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch },
  }
}

function jevResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function driverResponse(text: string) {
  return {
    content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'claude-sonnet-5', _request_id: 'r1',
    usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 },
  }
}

function flightItem(sourceId: string, priceMinor: number, stops: number): SupplierItem {
  return {
    sourceId, supplier: 'mock', kind: 'flight', name: `flight ${sourceId}`,
    price: money(BigInt(priceMinor), 'EUR'), priceBasis: 'total',
    fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
    detail: {
      kind: 'flight',
      outbound: {
        from: 'BCN', to: 'TYO', departureLocal: '2026-11-19T08:00:00', arrivalLocal: '2026-11-19T20:00:00',
        stops, route: ['BCN', 'TYO'], cabinClass: 'Economy', carriers: ['ZZ'], flightNumbers: ['ZZ1'],
      },
      inbound: null,
      baggage: { personalItem: 1, cabinBag: 0, checkedBag: 1 }, totalDurationSeconds: 12_000, selfTransfer: false,
    },
  }
}

const FILTER_ANSWERS = {
  intent: { type: 'choice', choice: 'filter', confidence: 0.95, probabilities: {} },
  nonstop: { type: 'noul', noul: 0.9 },
  departure: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} },
  cheaper: { type: 'noul', noul: 0.1 },
}

describeDb('makeRouter', () => {
  it('filter: "only direct flights" applies nonstop over the stored results, no supplier call, records seat router', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '01')
      const items: SupplierItem[] = [
        flightItem('F1', 20_000, 0),
        flightItem('F2', 20_000, 1),
        flightItem('F3', 20_000, 0),
      ]
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, items,
        params: {
          kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: null, flexDays: 0,
          adults: 1, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
        },
      })
      const resultsContent: ResultsContent = {
        kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
        sourceIds: items.map((i) => i.sourceId), assumptions: [],
      }
      await insertMessage(sql, s, 'results', JSON.stringify(resultsContent))
      await insertMessage(sql, s, 'user', 'only direct flights')

      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test', answers: FILTER_ANSWERS, usage: { input_tokens: 400, output_tokens: 100 },
      }))
      const create = vi.fn()

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'only direct flights'))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.attachments).toHaveLength(1)
      const attachment = step.attachments![0]!
      expect(attachment.role).toBe('results')
      const content = attachment.content as ResultsContent
      expect(content.sourceIds).toEqual(['F1', 'F3'])
      expect(content.filter?.nonstop).toBe(true)
      expect(step.message).toBe('Showing 2 of 3: nonstop.')
      expect(searchSpy).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()

      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['router'])
      expect(step.costMicros).toBe(BigInt(calls[0]!.cost_micros))
    })
  })

  it('question/chat: the driver runs, and the router\'s own Jev cost is added on top of the driver\'s', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '02')
      await insertMessage(sql, s, 'user', 'thanks, that helps')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { intent: { type: 'choice', choice: 'chat', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 350, output_tokens: 90 },
      }))
      const create = vi.fn().mockResolvedValue(driverResponse('Glad to help.'))
      const flights = new MockSupplier({ kind: 'flight' })

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'thanks, that helps'))

      expect(create).toHaveBeenCalledTimes(1) // the driver really ran
      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId} order by seat`
      expect(calls.map((r) => r.seat)).toEqual(['driver', 'router'])
      const routerCost = BigInt(calls.find((r) => r.seat === 'router')!.cost_micros)
      // The driver debits its own call (recordedMicros); costMicros carries only what nobody has
      // debited yet — the router's own call, added on top by `withExtraCost`.
      expect(step.kind === 'message' || step.kind === 'park').toBe(true)
      if ('costMicros' in step) expect(step.costMicros).toBe(routerCost)
    })
  })

  it('faq: a fixed answer, no model call of any kind', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '03')
      await insertMessage(sql, s, 'user', 'do you take payment or just book it?')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { intent: { type: 'choice', choice: 'faq', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 300, output_tokens: 60 },
      }))
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'do you take payment or just book it?'))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toContain('booking links')
      expect(create).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(1) // the router's own classification call — never a second one for the answer itself
    })
  })

  it('a choice action re-runs intake on the hydrated original message with the override, and records only seat intake (no router call)', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '04')
      const original = 'a week somewhere, not sure where from or to'
      await insertMessage(sql, s, 'user', original, true)
      const action: ActionPayload = { action: 'choice', questionId: 'origin', optionId: 'BCN' }
      await insertMessage(sql, s, 'action', JSON.stringify(action), true)

      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: {
          // Low confidence on both — the origin override (confidence 1) must let origin resolve
          // without a choice card, while destination, UNtouched by the override, still gets one.
          origin: { type: 'choice', choice: 'none', confidence: 0.3, probabilities: { none: 0.3, BCN: 0.2, MAD: 0.1 } },
          destination: { type: 'choice', choice: 'none', confidence: 0.3, probabilities: { none: 0.3, TYO: 0.4, OSA: 0.3 } },
        },
        usage: { input_tokens: 500, output_tokens: 150 },
      }))
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')

      // The DB holds the real newest row (the action); `ctx.state.messages` is what a real
      // claimed turn's hydrated transcript would carry — her ORIGINAL message as the newest
      // `user` entry (the action/choices rows between them all hydrate to `system`).
      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, original))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.attachments).toHaveLength(1)
      expect(step.attachments![0]!.role).toBe('choices')
      expect((step.attachments![0]!.content as { questionId: string }).questionId).toBe('destination')
      expect(searchSpy).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(1) // intake's own call only — no routeMessage call for a choice action

      const calls = await sql`select seat from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['intake'])
    })
  })

  it('a choose action dispatches straight to the Task 7 stub, no Jev call at all', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '05')
      const action: ActionPayload = { action: 'choose', kind: 'flight', sourceId: 'F1' }
      await insertMessage(sql, s, 'action', JSON.stringify(action))

      const fetchImpl = vi.fn()
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'irrelevant'))

      expect(step).toEqual({ kind: 'park', message: 'Noted.', costMicros: 0n })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    })
  })

  it('a hand_off action goes straight to the driver, no Jev call', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '06')
      const action: ActionPayload = { action: 'hand_off', proposalId: '00000000-0000-4000-8000-000000000001' }
      await insertMessage(sql, s, 'action', JSON.stringify(action))

      const fetchImpl = vi.fn()
      const create = vi.fn().mockResolvedValue(driverResponse('On it.'))
      const flights = new MockSupplier({ kind: 'flight' })

      await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'irrelevant'))

      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).toHaveBeenCalledTimes(1)
    })
  })
})

describe('routeMessage', () => {
  it('matches an airline code from the corpus as a whole word, case-insensitively', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test', answers: FILTER_ANSWERS, usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'only on lh please', false, { carriers: ['LH', 'FR'] })
    expect(result.intent).toBe('filter')
    expect(result.filter?.airlines).toEqual(['LH'])
  })

  it('extracts a spelled price cap into minor units when the cheaper signal fires', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test',
      answers: { ...FILTER_ANSWERS, nonstop: { type: 'noul', noul: 0 }, cheaper: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'show me something under 500', false)
    expect(result.filter?.maxPriceMinor).toBe('50000')
  })

  it('a non-filter intent carries no filter at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test',
      answers: { intent: { type: 'choice', choice: 'new_search', confidence: 0.9, probabilities: {} } },
      usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'actually make it Lisbon instead', true)
    expect(result.intent).toBe('new_search')
    expect(result.filter).toBeUndefined()
  })
})
