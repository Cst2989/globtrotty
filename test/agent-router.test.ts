import { describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeRouter, routeMessage } from '../src/agents/router.js'
import { runTurn } from '../src/worker.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { money } from '../src/money.js'
import type { SupplierItem } from '../src/supplier/types.js'
import type { ResultsContent, ChoicesContent } from '../src/results.js'
import type { ActionPayload } from '../src/actions.js'
import { NO_FILTER_MESSAGE } from '../src/agents/stage.js'

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
  sql: postgres.Sql, s: Seeded, role: 'user' | 'results' | 'choices' | 'action', content: string, clock = false,
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
    content: [{ type: 'text', text }], stop_reason: 'end_turn', model: 'claude-opus-5', _request_id: 'r1',
    usage: { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 },
  }
}

function driverToolResponse(name: string, input: unknown) {
  return {
    content: [
      { type: 'thinking', thinking: 'deciding', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name, input },
    ],
    stop_reason: 'tool_use', model: 'claude-opus-5', _request_id: 'r2',
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
      // F2: the filtered results row, then the next-step chips.
      expect(step.attachments!.map((a) => a.role)).toEqual(['results', 'choices'])
      const attachment = step.attachments![0]!
      const chips = step.attachments![1]!.content as { questionId: string; options: { id: string }[] }
      expect(chips.questionId).toBe('next')
      expect(chips.options.map((o) => o.id)).toEqual(['show_all', 'evening'])
      const content = attachment.content as ResultsContent
      expect(content.sourceIds).toEqual(['F1', 'F3'])
      expect(content.filter?.nonstop).toBe(true)
      // Section 8c: the reply names the best of what is left, not only the arithmetic.
      expect(step.message).toBe('Showing 2 of 3: nonstop. The cheapest is flight F1 at €200.00.')
      expect(searchSpy).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()

      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['router'])
      expect(step.costMicros).toBe(BigInt(calls[0]!.cost_micros))
    })
  })

  // I1: a typed filter must apply over the UNFILTERED corpus, not over whatever the newest
  // results row happens to be. Before this, the second filter narrowed an already-narrowed set
  // and no typed message could widen it again.
  it('filter: a second typed filter applies over the unfiltered corpus, not the first filter\'s output', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '10')
      // F1 nonstop, F2 one stop, F3 nonstop: "nonstop" keeps F1/F3, and a FOLLOWING
      // "up to one stop" must come back to all three rather than re-filtering {F1, F3}.
      const items: SupplierItem[] = [flightItem('F1', 20_000, 0), flightItem('F2', 20_000, 1), flightItem('F3', 20_000, 0)]
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, items,
        params: {
          kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: null, flexDays: 0,
          adults: 1, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
        },
      })
      const unfiltered: ResultsContent = {
        kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
        sourceIds: ['F1', 'F2', 'F3'], assumptions: [],
      }
      await insertMessage(sql, s, 'results', JSON.stringify(unfiltered), true)
      // The first filter's own output row, which is what `readLatestResults` would return.
      await insertMessage(sql, s, 'results', JSON.stringify({
        ...unfiltered, sourceIds: ['F1', 'F3'], filter: { nonstop: true },
      }), true)
      await insertMessage(sql, s, 'user', 'up to one stop is fine', true)

      const flights = new MockSupplier({ kind: 'flight' })
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { ...FILTER_ANSWERS, nonstop: { type: 'noul', noul: 0.1 }, one_stop_ok: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 400, output_tokens: 100 },
      }))

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(ctx(s, 'up to one stop is fine'))

      if (step.kind !== 'park') throw new Error('unreachable')
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.sourceIds).toEqual(['F1', 'F2', 'F3'])      // widened, not compounded
      expect(content.filter?.maxStops).toBe(1)
      expect(step.message).toBe('Showing 3 of 3: up to 1 stop. The cheapest is flight F1 at €200.00.')
    })
  })

  it('filter: "show me all flights" widens back to the full stored set (I1)', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '11')
      const items: SupplierItem[] = [flightItem('F1', 20_000, 0), flightItem('F2', 20_000, 1), flightItem('F3', 20_000, 0)]
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, items,
        params: {
          kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: null, flexDays: 0,
          adults: 1, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
        },
      })
      const unfiltered: ResultsContent = {
        kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
        sourceIds: ['F1', 'F2', 'F3'], assumptions: [],
      }
      await insertMessage(sql, s, 'results', JSON.stringify(unfiltered), true)
      await insertMessage(sql, s, 'results', JSON.stringify({
        ...unfiltered, sourceIds: ['F1', 'F3'], filter: { nonstop: true },
      }), true)
      await insertMessage(sql, s, 'user', 'show me all flights', true)

      const flights = new MockSupplier({ kind: 'flight' })
      // An empty filter: every signal off. "Showing 2 of 2: all results" was the old answer.
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: {
          intent: { type: 'choice', choice: 'filter', confidence: 0.95, probabilities: {} },
          nonstop: { type: 'noul', noul: 0.05 }, one_stop_ok: { type: 'noul', noul: 0.05 },
          departure: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} },
          cheaper: { type: 'noul', noul: 0.05 },
        },
        usage: { input_tokens: 400, output_tokens: 100 },
      }))

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(ctx(s, 'show me all flights'))

      if (step.kind !== 'park') throw new Error('unreachable')
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.sourceIds).toEqual(['F1', 'F2', 'F3'])
      expect(step.message).toBe('Showing 3 of 3: all results. The cheapest is flight F1 at €200.00.')
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

  it('a choice action re-runs intake on her ORIGINAL message with the override, and records only seat intake (no router call)', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '04')
      const original = 'a week somewhere, not sure where from or to'
      await insertMessage(sql, s, 'user', original, true)
      const choices: ChoicesContent = {
        questionId: 'origin', question: 'Which city are you flying from?',
        options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }],
      }
      await insertMessage(sql, s, 'choices', JSON.stringify(choices), true)
      // C3: the rows `submitAction` ACTUALLY writes for a click — the option's label as a `user`
      // row (`ChoiceCardLive` always sends `text: label`), then the action row, both on
      // `clock_timestamp()` so the action is strictly later. The previous version of this test
      // never wrote the note, so it asserted a transcript production never produces: the newest
      // `user` entry in a real turn is "Barcelona", and intake used to re-run on THAT.
      await insertMessage(sql, s, 'user', 'Barcelona', true)
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

      // `ctx.state.messages` carries what `loop()` would really hydrate: the newest `user`
      // entry is the CLICK, not the request. If the router still read the transcript, intake
      // would run on "Barcelona" and the assertion below would fail.
      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'Barcelona'))

      // The text intake actually ran on, read off the Jev request body.
      const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
        state: { message: string }
      }
      expect(sent.state.message).toBe(original)

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

  it('C3: a SECOND card in the chain still re-runs on her original message, not the first click', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '09')
      const original = 'a week somewhere, not sure where from or to'
      await insertMessage(sql, s, 'user', original, true)
      // Card 1 (origin) -> she clicks Barcelona -> intake re-runs and asks for the destination
      // -> card 2 -> she clicks Tokyo. Every `user` row before card 2 except her request is a
      // click note, which is why `readNewestUserTextBefore` skips a `user` row whose next row
      // is an `action`: taking simply "the newest user row before the card" would hand intake
      // "Barcelona" here — the same bug, one card further along.
      const originCard: ChoicesContent = {
        questionId: 'origin', question: 'Which city are you flying from?',
        options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }],
      }
      await insertMessage(sql, s, 'choices', JSON.stringify(originCard), true)
      await insertMessage(sql, s, 'user', 'Barcelona', true)
      await insertMessage(sql, s, 'action', JSON.stringify({ action: 'choice', questionId: 'origin', optionId: 'BCN' } satisfies ActionPayload), true)
      const destCard: ChoicesContent = {
        questionId: 'destination', question: 'Where is the trip to?',
        options: [{ id: 'TYO', label: 'Tokyo' }, { id: 'OSA', label: 'Osaka' }],
      }
      await insertMessage(sql, s, 'choices', JSON.stringify(destCard), true)
      await insertMessage(sql, s, 'user', 'Tokyo', true)
      await insertMessage(sql, s, 'action', JSON.stringify({ action: 'choice', questionId: 'destination', optionId: 'TYO' } satisfies ActionPayload), true)

      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: {
          origin: { type: 'choice', choice: 'none', confidence: 0.3, probabilities: { none: 0.3, BCN: 0.2 } },
          destination: { type: 'choice', choice: 'none', confidence: 0.3, probabilities: { none: 0.3, TYO: 0.4 } },
        },
        usage: { input_tokens: 500, output_tokens: 150 },
      }))
      const flights = new MockSupplier({ kind: 'flight' })

      await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(ctx(s, 'Tokyo'))

      const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
        state: { message: string }
      }
      expect(sent.state.message).toBe(original)
    })
  })

  it('fix round 1: a choice action is refused when it was never actually offered — no Jev call, no spend', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '07')
      const original = 'a week somewhere, not sure where from or to'
      await insertMessage(sql, s, 'user', original, true)
      // The office only ever offered an `origin` card with BCN/MAD — a forged action naming a
      // DIFFERENT questionId (and an optionId that was never one of the offered ids either) must
      // not be trusted at face value, however id-shaped `ActionPayload`'s own regex lets it be.
      const choices: ChoicesContent = {
        questionId: 'origin', question: 'Which city are you flying from?',
        options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }],
      }
      await insertMessage(sql, s, 'choices', JSON.stringify(choices), true)
      const forged: ActionPayload = { action: 'choice', questionId: 'outbound', optionId: 'BCN' }
      await insertMessage(sql, s, 'action', JSON.stringify(forged), true)

      const fetchImpl = vi.fn()
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, original))

      expect(step).toEqual({ kind: 'park', message: 'That option is no longer available. Tell me in your own words.', costMicros: 0n })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(searchSpy).not.toHaveBeenCalled()
      const calls = await sql`select seat from model_calls where conversation_id = ${s.conversationId}`
      expect(calls).toHaveLength(0)
      const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(0n)
    })
  })

  it('fix round 1: a right questionId but an optionId never offered is refused too', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '08')
      const original = 'a week somewhere, not sure where from or to'
      await insertMessage(sql, s, 'user', original, true)
      const choices: ChoicesContent = {
        questionId: 'origin', question: 'Which city are you flying from?',
        options: [{ id: 'BCN', label: 'Barcelona' }, { id: 'MAD', label: 'Madrid' }],
      }
      await insertMessage(sql, s, 'choices', JSON.stringify(choices), true)
      const forged: ActionPayload = { action: 'choice', questionId: 'origin', optionId: 'LIS' }
      await insertMessage(sql, s, 'action', JSON.stringify(forged), true)

      const fetchImpl = vi.fn()
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, original))

      expect(step).toEqual({ kind: 'park', message: 'That option is no longer available. Tell me in your own words.', costMicros: 0n })
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  // Plan 5 Task 7 replaced the stub `handleChoose` (src/agents/choose.ts) with the real
  // handler — this id names no corpus row for this conversation, so it reaches the same
  // "no longer available" park `handleChoose` returns for any card id that doesn't
  // resolve, never a model or Jev call either way.
  it('a choose action dispatches straight to handleChoose, no Jev call at all', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '05')
      const action: ActionPayload = { action: 'choose', kind: 'flight', sourceId: 'F1' }
      await insertMessage(sql, s, 'action', JSON.stringify(action))

      const fetchImpl = vi.fn()
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'irrelevant'))

      expect(step).toEqual({
        kind: 'park', message: 'That flight is no longer available. Pick another.', costMicros: 0n,
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    })
  })

  // Pass 3, section 1d: a `refresh` action belongs beside `choose` rather than with the driver.
  // This conversation has no stored `results` row of that kind, so it reaches the same refusal
  // `handleRefresh` gives for any press with nothing to re-run — and makes no Jev, model or
  // supplier call on the way there.
  it('a refresh action dispatches straight to handleRefresh, no Jev call at all', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '20')
      const action: ActionPayload = { action: 'refresh', kind: 'flight' }
      await insertMessage(sql, s, 'action', JSON.stringify(action))

      const fetchImpl = vi.fn()
      const create = vi.fn()
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')

      const step = await makeRouter(deps(sql, fetchImpl, create, flights))(ctx(s, 'irrelevant'))

      expect(step).toEqual({
        kind: 'park', message: 'I do not have a search to refresh. Tell me the trip again.', costMicros: 0n,
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(searchSpy).not.toHaveBeenCalled()
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

  // I5: `withExtraCost` folded the router's own Jev cost into `step.costMicros`, but
  // `src/worker.ts`'s `case 'tool'` only calls `recordSpend(step.costMicros)` in the FRESH
  // branch — `replayed` skips it (the first attempt already paid for that tool call) and
  // `ambiguous` `failTurn`s without it. On a resumed turn the router makes a genuinely NEW Jev
  // call, with its own `model_calls` row and a real `cost_micros`, that never reached
  // `conversations.spend_usd_micros`. The invariant asserted here is the one that matters: every
  // `model_calls` row's cost reaches the conversation and turn totals.
  it('I5: the router\'s Jev cost reaches the totals even when the driver\'s tool step is replayed', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '12')
      await insertMessage(sql, s, 'user', 'what is the weather like in Tokyo in November?', true)
      // A tool call this turn already finished before it was killed: `beginToolCall` reports
      // `replayed` for it, so the worker takes the branch that skips `recordSpend`.
      await sql`
        insert into tool_calls (turn_id, call_id, name, status, result)
        values (${s.turnId}, ${'toolu_1'}, ${'explore_flights'}, 'done', ${JSON.stringify({ items: [] })})`
      // `claimTurn` takes a 'queued' turn, or a 'running' one whose heartbeat has gone stale —
      // and `now()` is frozen inside `withTestDb`'s transaction, so staleness is unreachable
      // here. A requeued turn is exactly the shape this test is about.
      await sql`update turns set status = 'queued' where id = ${s.turnId}`

      const CHAT_ANSWERS = { intent: { type: 'choice', choice: 'chat', confidence: 0.95, probabilities: {} } }
      const fetchImpl = vi.fn().mockResolvedValue(jevResponse({
        model: 'jev-test', answers: CHAT_ANSWERS, usage: { input_tokens: 400, output_tokens: 100 },
      }))
      // Step 0: the driver asks for a tool (replayed). Step 1: it answers in words, ending the turn.
      const create = vi.fn()
        .mockResolvedValueOnce(driverToolResponse('explore_flights', {
          from: 'BCN', to: 'TYO', departureDate: '2026-11-19', adults: 1,
        }))
        .mockResolvedValue(driverResponse('November in Tokyo is mild and dry.'))

      await runTurn({
        sql, limits: DEFAULT_LIMITS,
        agent: makeRouter(deps(sql, fetchImpl, create, new MockSupplier({ kind: 'flight' }))),
        now: () => Date.now(), deadlineMs: () => Date.now() + 600_000,
        reinvoke: async () => {}, notifier: new LogNotifier(() => {}),
      }, s.turnId)

      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      // Two router Jev calls (one per step) and two driver calls.
      expect(calls.filter((r) => r.seat === 'router')).toHaveLength(2)
      expect(calls.filter((r) => r.seat === 'driver')).toHaveLength(2)
      const billed = calls.reduce((sum, r) => sum + BigInt(r.cost_micros), 0n)
      expect(billed).toBeGreaterThan(0n)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      const [turn] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from turns where id = ${s.turnId}`
      // Before the fix the FIRST router call's cost was missing from both.
      expect(BigInt(conv!.spend_usd_micros)).toBe(billed)
      expect(BigInt(turn!.spend_usd_micros)).toBe(billed)
    })
  })

  // The bug: "I don't want to stop in China or the Middle East" used to classify as `filter`,
  // resolve to an empty `Filter` (nothing matched), and reply "Showing 10 of 10: all results."
  // as though the office had understood and agreed. An empty `Filter` now gets the honest
  // admission instead — the conversation's own stage chips, and no `results` attachment, since
  // the list on screen never changed.
  it('filter: a message nothing resolves to gets the honest admission, not "all results"', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '12')
      const items: SupplierItem[] = [flightItem('F1', 20_000, 0), flightItem('F2', 20_000, 1)]
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
      await insertMessage(sql, s, 'user', 'make it sparkle')

      const flights = new MockSupplier({ kind: 'flight' })
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { intent: { type: 'choice', choice: 'filter', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 400, output_tokens: 100 },
      }))

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(ctx(s, 'make it sparkle'))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe(NO_FILTER_MESSAGE)
      // Stage chips, never `nextStepsAttachment('filter')` — and no `results` attachment, since
      // nothing was actually filtered.
      expect(step.attachments).toHaveLength(1)
      expect(step.attachments![0]!.role).toBe('choices')
      const chips = step.attachments![0]!.content as ChoicesContent
      expect(chips.options.map((o) => o.id)).not.toContain('show_all')
    })
  })

  // Section 8c's own instinct, now for the connections filter: say what was applied AND the
  // best of what is left, described by its airline and where it connects — never the masked
  // supplier `name`, which says nothing about why this one survived the filter she just typed.
  it('filter: avoiding the Middle East names the cheapest survivor by airline and via city', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '13')
      const viaDoha = (sourceId: string, priceMinor: number): SupplierItem => ({
        sourceId, supplier: 'mock', kind: 'flight', name: 'Masked Supplier Name',
        price: money(BigInt(priceMinor), 'EUR'), priceBasis: 'total',
        fetchedAt: new Date('2026-10-03T12:00:00Z'), ttlSeconds: 900, bookingUrl: null,
        detail: {
          kind: 'flight',
          outbound: {
            from: 'BCN', to: 'TYO', departureLocal: '2026-11-19T08:00:00', arrivalLocal: '2026-11-19T20:00:00',
            stops: 1, route: ['BCN', 'DOH', 'TYO'], cabinClass: 'Economy', carriers: ['QR'], flightNumbers: ['QR1'],
          },
          inbound: null,
          baggage: { personalItem: 1, cabinBag: 0, checkedBag: 1 }, totalDurationSeconds: 30_000, selfTransfer: false,
        },
      })
      const items: SupplierItem[] = [viaDoha('F1', 50_000), flightItem('F2', 40_000, 0)]
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
      await insertMessage(sql, s, 'user', 'i dont want to stop in the middle east')

      const flights = new MockSupplier({ kind: 'flight' })
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: {
          intent: { type: 'choice', choice: 'filter', confidence: 0.95, probabilities: {} },
          avoid_connections: { type: 'noul', noul: 0.95 },
        },
        usage: { input_tokens: 400, output_tokens: 100 },
      }))

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(
        ctx(s, 'i dont want to stop in the middle east'),
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      // F1 (via Doha) is excluded; F2 is the only, and therefore cheapest, survivor — the
      // supplier's own masked `name` ("flight F2") never appears.
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.sourceIds).toEqual(['F2'])
      expect(content.filter?.avoidRegions).toEqual(['middle_east'])
      expect(step.message).not.toContain('Masked Supplier Name')
      expect(step.message).not.toContain('flight F2')
      expect(step.message).toBe('Showing 1 of 2: no connections in the Middle East. The cheapest is ZZ at €400.00.')
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

  // Unrecorded deviation 5: `Filter.maxStops` was unreachable from any typed message.
  it('reads "up to one stop" into maxStops 1, and nonstop still wins when both fire', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { ...FILTER_ANSWERS, nonstop: { type: 'noul', noul: 0.1 }, one_stop_ok: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 200, output_tokens: 50 },
      }))
      .mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { ...FILTER_ANSWERS, nonstop: { type: 'noul', noul: 0.9 }, one_stop_ok: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 200, output_tokens: 50 },
      }))
    const jev = { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }

    const one = await routeMessage({ jev }, 'up to one stop is fine', true)
    expect(one.filter?.maxStops).toBe(1)
    expect(one.filter?.nonstop).toBeUndefined()

    const both = await routeMessage({ jev }, 'direct, or one stop at a push', true)
    expect(both.filter?.nonstop).toBe(true)
    expect(both.filter?.maxStops).toBeUndefined()
  })

  it('asks Jev about one stop at all — the question must exist for maxStops to be reachable', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test', answers: FILTER_ANSWERS, usage: { input_tokens: 200, output_tokens: 50 },
    }))
    await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } }, 'anything', true)
    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      questions: Record<string, unknown>
    }
    expect(Object.keys(sent.questions)).toContain('one_stop_ok')
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

  // The bug: this exact sentence used to classify as `filter` and change nothing at all,
  // because no dimension named a connection's own country. `avoid_connections` firing resolves
  // the alias table (`resolveConnectionsAvoidance`, src/intake/regions.ts) over the raw text.
  it('"i dont want to stop in china or the middle east" resolves to avoidRegions china, middle_east', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test',
      answers: {
        ...FILTER_ANSWERS, nonstop: { type: 'noul', noul: 0.1 }, avoid_connections: { type: 'noul', noul: 0.95 },
      },
      usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'i dont want to stop in china or the middle east', true)
    expect(result.intent).toBe('filter')
    expect(result.filter).toEqual({ avoidRegions: ['china', 'middle_east'] })
  })

  it('an unrecognised filter message resolves to an empty Filter, not a guess', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test',
      answers: { intent: { type: 'choice', choice: 'filter', confidence: 0.9, probabilities: {} } },
      usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'make it sparkle', true)
    expect(result.intent).toBe('filter')
    expect(result.filter).toEqual({})
  })

  it('"direct" and a bare "no connections" both map to nonstop', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { intent: { type: 'choice', choice: 'filter', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 200, output_tokens: 50 },
      }))
      .mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { intent: { type: 'choice', choice: 'filter', confidence: 0.9, probabilities: {} } },
        usage: { input_tokens: 200, output_tokens: 50 },
      }))
    const jev = { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }
    const direct = await routeMessage({ jev }, 'direct flights please', true)
    expect(direct.filter).toEqual({ nonstop: true })
    const noConnections = await routeMessage({ jev }, 'no connections please', true)
    expect(noConnections.filter).toEqual({ nonstop: true })
  })

  it('"no connections in china" is the connections filter, not nonstop', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
      model: 'jev-test',
      answers: {
        intent: { type: 'choice', choice: 'filter', confidence: 0.9, probabilities: {} },
        avoid_connections: { type: 'noul', noul: 0.95 },
      },
      usage: { input_tokens: 200, output_tokens: 50 },
    }))
    const result = await routeMessage({ jev: { apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch } },
      'no connections in china', true)
    expect(result.filter).toEqual({ avoidRegions: ['china'] })
  })
})

/**
 * Results UI pass 2, F3: the `next` chips. A click on one arrives as a `choice` action with
 * `questionId: 'next'`, and it must NOT be treated as an answer to a question the office asked —
 * which is what an origin/destination/outbound card is, and what makes intake re-run with an
 * override. Two ids the router answers itself; the rest run through the ordinary typed path on
 * the option's LABEL, which the `userNote` row already carries.
 */
describeDb('makeRouter: the `next` chips', () => {
  const RESULTS: ResultsContent = {
    kind: 'flights', query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: null, adults: 1 },
    sourceIds: ['F1', 'F2', 'F3'], assumptions: [],
  }
  const NEXT_CHOICES: ChoicesContent = {
    questionId: 'next', question: 'What next?',
    options: [
      { id: 'direct_only', label: 'Direct flights only' },
      { id: 'get_links', label: 'Accept the trip' },
      { id: 'change_flight', label: 'Change the flight' },
    ],
  }

  /** The rows `submitAction` really writes for a chip click: the label as a `user` row, then the action. */
  async function seedClick(sql: postgres.Sql, s: Seeded, optionId: string, label: string) {
    await insertMessage(sql, s, 'user', 'flights to tokyo in november', true)
    await insertMessage(sql, s, 'results', JSON.stringify(RESULTS), true)
    await insertMessage(sql, s, 'choices', JSON.stringify(NEXT_CHOICES), true)
    await insertMessage(sql, s, 'user', label, true)
    const action: ActionPayload = { action: 'choice', questionId: 'next', optionId }
    await insertMessage(sql, s, 'action', JSON.stringify(action), true)
  }

  it('get_links points at the button and spends nothing at all', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '20')
      await seedClick(sql, s, 'get_links', 'Accept the trip')
      const fetchImpl = vi.fn()
      const create = vi.fn()

      const step = await makeRouter(deps(sql, fetchImpl, create, new MockSupplier({ kind: 'flight' })))(
        ctx(s, 'Get booking links'),
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Press "Accept this trip" on the summary to the right.')
      // The hand-off is a button, not a message: no Jev classification, no driver turn.
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      const calls = await sql`select 1 from model_calls where conversation_id = ${s.conversationId}`
      expect(calls).toHaveLength(0)
    })
  })

  it('change_flight re-shows the newest UNFILTERED flights row, with no model call', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '21')
      await insertMessage(sql, s, 'user', 'flights to tokyo in november', true)
      await insertMessage(sql, s, 'results', JSON.stringify(RESULTS), true)
      // A filter's own output row sits on top of it — she must land on the full list, not this.
      await insertMessage(sql, s, 'results', JSON.stringify({
        ...RESULTS, sourceIds: ['F1'], filter: { nonstop: true },
      }), true)
      await insertMessage(sql, s, 'choices', JSON.stringify(NEXT_CHOICES), true)
      await insertMessage(sql, s, 'user', 'Change the flight', true)
      await insertMessage(sql, s, 'action', JSON.stringify(
        { action: 'choice', questionId: 'next', optionId: 'change_flight' } satisfies ActionPayload,
      ), true)
      const fetchImpl = vi.fn()
      const create = vi.fn()

      const step = await makeRouter(deps(sql, fetchImpl, create, new MockSupplier({ kind: 'flight' })))(
        ctx(s, 'Change the flight'),
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('Pick another flight.')
      expect(step.attachments!.map((a) => a.role)).toEqual(['results', 'choices'])
      const content = step.attachments![0]!.content as ResultsContent
      expect(content.sourceIds).toEqual(['F1', 'F2', 'F3'])
      expect(content.filter).toBeUndefined()
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    })
  })

  it('change_flight says so plainly when there is no flight list to go back to', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '22')
      await insertMessage(sql, s, 'user', 'hello', true)
      await insertMessage(sql, s, 'choices', JSON.stringify(NEXT_CHOICES), true)
      await insertMessage(sql, s, 'user', 'Change the flight', true)
      await insertMessage(sql, s, 'action', JSON.stringify(
        { action: 'choice', questionId: 'next', optionId: 'change_flight' } satisfies ActionPayload,
      ), true)

      const step = await makeRouter(deps(sql, vi.fn(), vi.fn(), new MockSupplier({ kind: 'flight' })))(
        ctx(s, 'Change the flight'),
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('I do not have a flight list to go back to. Tell me the trip again.')
      expect(step.attachments).toBeUndefined()
    })
  })

  it('every other chip runs the ordinary typed path on the option LABEL, never an intake override', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '23')
      const items: SupplierItem[] = [
        flightItem('F1', 20_000, 0), flightItem('F2', 20_000, 1), flightItem('F3', 20_000, 0),
      ]
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, items,
        params: {
          kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: null, flexDays: 0,
          adults: 1, children: 0, infants: 0, cabinClass: 'Economy', currency: 'EUR', maxStops: null,
          allowSelfTransfer: false,
        },
      })
      await seedClick(sql, s, 'direct_only', 'Direct flights only')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test', answers: FILTER_ANSWERS, usage: { input_tokens: 400, output_tokens: 100 },
      }))
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), flights))(ctx(s, 'Direct flights only'))

      // Exactly one Jev call, and it classified the LABEL — not her original message, and not an
      // intake re-run (which is what a non-`next` questionId would have produced).
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
        state: { message: string }
        questions: Record<string, unknown>
      }
      expect(sent.state.message).toBe('Direct flights only')
      expect(Object.keys(sent.questions)).toContain('intent')   // the ROUTER's questions, not intake's
      expect(Object.keys(sent.questions)).not.toContain('origin')
      expect(searchSpy).not.toHaveBeenCalled()

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      // Section 8c: the reply names the best of what is left, not only the arithmetic.
      expect(step.message).toBe('Showing 2 of 3: nonstop. The cheapest is flight F1 at €200.00.')
      const calls = await sql<{ seat: string }[]>`
        select seat from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['router'])
    })
  })

  it('still validates a `next` click against the stored row, so a forged id costs nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seedConversation(sql, '24')
      await seedClick(sql, s, 'direct_only', 'Direct flights only')
      // A forged id that was never offered.
      await insertMessage(sql, s, 'action', JSON.stringify(
        { action: 'choice', questionId: 'next', optionId: 'free_upgrade' } satisfies ActionPayload,
      ), true)
      const fetchImpl = vi.fn()

      const step = await makeRouter(deps(sql, fetchImpl, vi.fn(), new MockSupplier({ kind: 'flight' })))(
        ctx(s, 'Free upgrade'),
      )

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toBe('That option is no longer available. Tell me in your own words.')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })
})
