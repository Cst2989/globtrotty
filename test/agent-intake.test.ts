import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import tokyo from './fixtures/jev/tokyo.json' with { type: 'json' }
import { withTestDb, describeDb } from './helpers/db.js'
import { makeIntake } from '../src/agents/intake.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { LogNotifier } from '../src/notify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { loadNotebook } from '../src/repo/notebook.js'
import { emptyNotebook } from '../src/notebook.js'

// The author's own message, re-recorded as test/fixtures/jev/tokyo.json (task 5, LIVE_JEV=1) —
// see test/intake-brief.test.ts and task-5-report.md.
const MSG = 'i need to be in tokio with my wife on 20th of nov, from barcelona, and back in barcelona sunday 6th of december. i would like to fly on the long trips premium economie and on short economy, and for acomodation i am staying most of the time in tokio and i would like to visit everything turistic but not change a lot of hotels but i will also travel in kioto, i will visit the nintendo museum on the 3rd'
const NOW = new Date('2026-10-03T12:00:00Z')

/**
 * A hand-built (never recorded) rerank response for the 5 items `MockSupplier`'s default count
 * returns. Same reasoning as test/intake-rank.test.ts: a score answer is schema-only, and a
 * hand-built fixture of five arbitrary scores exercises `rankItems`'s ordering exactly as well
 * as a live one would.
 */
const RANK_FIXTURE = {
  model: 'jev-test',
  answers: Object.fromEntries(
    [3, 1, 2, 0, 1].map((score, i) => [`o${i}`, { type: 'score', score, confidence: 0.9, probabilities: {} }]),
  ),
  usage: { input_tokens: 350, output_tokens: 120 },
}

function jevResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

type Seeded = { userId: string; conversationId: string; turnId: string }

async function seed(sql: postgres.Sql, n: string): Promise<Seeded> {
  const userId = `00000000-0000-4000-8000-0000000009${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`
    insert into turns (conversation_id, user_id, idempotency_key, status)
    values (${c!.id}, ${userId}, ${'i' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}

function ctx(s: Seeded, text: string) {
  return {
    conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
    state: { step: 0, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] },
  }
}

function deps(sql: postgres.Sql, fetchImpl: ReturnType<typeof vi.fn>, flights: MockSupplier) {
  return {
    sql, transport: { create: vi.fn() }, flights, hotels: new MockSupplier({ kind: 'hotel' }),
    limits: DEFAULT_LIMITS, now: () => NOW.getTime(), notifier: new LogNotifier(() => {}),
    jev: { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch },
  }
}

describeDb('makeIntake', () => {
  it('brief -> search -> rerank -> a results row of <=10 ids, all in tool_results, desk flipped, cost = sum of both model_calls', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const flights = new MockSupplier({ kind: 'flight' }) // default count: 5
      const searchSpy = vi.spyOn(flights, 'search')
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jevResponse(tokyo))
        .mockResolvedValueOnce(jevResponse(RANK_FIXTURE))
      const step = await makeIntake(deps(sql, fetchImpl, flights))(ctx(s, MSG))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.attachments).toHaveLength(1)
      const attachment = step.attachments![0]!
      expect(attachment.role).toBe('results')
      const content = attachment.content as {
        kind: string
        query: { from?: string; to?: string; outbound: string; inbound: string | null; adults: number; cabin?: string }
        sourceIds: string[]
      }
      expect(content.kind).toBe('flights')
      expect(content.sourceIds.length).toBeLessThanOrEqual(10)
      expect(content.query).toMatchObject({
        from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2, cabin: 'premium_economy',
      })

      // Every id in the results row must actually be in tool_results for THIS conversation.
      const rows = await sql<{ source_id: string }[]>`
        select source_id from tool_results where conversation_id = ${s.conversationId}`
      const stored = new Set(rows.map((r) => r.source_id))
      for (const id of content.sourceIds) expect(stored.has(id)).toBe(true)

      // Fix round 1, spec §1.4: the direct supplier search still writes a tool_calls row, under
      // the same name the driver's own door uses, so it counts against the same per-turn budget.
      const toolCalls = await sql<{ name: string; status: string }[]>`
        select name, status from tool_calls where turn_id = ${s.turnId}`
      expect(toolCalls).toEqual([{ name: 'explore_flights', status: 'done' }])

      // Desk flipped to planning, and the title written from the brief (M2) — code-built from
      // the place table and the ISO dates, never a model call and never her words.
      const [c] = await sql<{ desk: string; title: string | null }[]>`
        select desk, title from conversations where id = ${s.conversationId}`
      expect(c!.desk).toBe('planning')
      expect(c!.title).toBe('Barcelona to Tokyo, 19 Nov to 6 Dec')

      // Exactly two model_calls rows, one per seat, and costMicros is their sum.
      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId} order by seat`
      expect(calls.map((r) => r.seat)).toEqual(['intake', 'rerank'])
      const sum = calls.reduce((acc, r) => acc + BigInt(r.cost_micros), 0n)
      expect(step.costMicros).toBe(sum)

      // The supplier was asked for exactly what the brief said, with the Kiwi cabin vocabulary.
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy.mock.calls[0]![0]).toMatchObject({
        kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: '2026-12-06',
        adults: 2, cabinClass: 'PremiumEconomy', currency: 'EUR', maxStops: null,
      })

      // Fixed English, built only from the brief's own enum/ISO values and the place table.
      expect(step.message).toBe(
        'Here are flights for 2 adults, Barcelona to Tokyo, 19 Nov to 6 Dec, premium economy. '
        + 'I assumed: the year 2026; leaving a day early so you arrive on the 20th. '
        + 'Change anything with the chips above the list or just tell me.',
      )

      // The notebook picked up what the brief resolved, in its own key vocabulary.
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb.originCity?.value).toBe('BCN')
      expect(nb.destination?.value).toBe('TYO')
      expect(nb.departureDate?.value).toBe('2026-11-19')
      expect(nb.returnDate?.value).toBe('2026-12-06')
      expect(nb.partySize?.value).toEqual({ adults: 2, children: 0, infants: 0 })
    })
  })

  it('a choices outcome parks with a choices attachment, costs only the intake call, and still flips the desk', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse({
        model: 'jev-test',
        answers: { origin: { type: 'choice', choice: 'none', confidence: 0.6, probabilities: { none: 0.5, BCN: 0.3, MAD: 0.2 } } },
        usage: { input_tokens: 200, output_tokens: 80 },
      }))
      const step = await makeIntake(deps(sql, fetchImpl, flights))(ctx(s, 'a week somewhere, not sure where from'))

      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.attachments).toHaveLength(1)
      expect(step.attachments![0]!.role).toBe('choices')
      expect(fetchImpl).toHaveBeenCalledTimes(1) // no rerank call: the turn never reached a search
      expect(searchSpy).not.toHaveBeenCalled()

      const [c] = await sql<{ desk: string; title: string | null }[]>`
        select desk, title from conversations where id = ${s.conversationId}`
      expect(c!.desk).toBe('planning') // ledger ruling: every run, brief or choices
      // No brief, no title: there is no trip to name yet.
      expect(c!.title).toBeNull()

      const calls = await sql`select seat from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['intake'])
      const [mc] = await sql<{ cost_micros: string }[]>`
        select cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(step.costMicros).toBe(BigInt(mc!.cost_micros))

      // Fix round 1: a choice card never reaches the supplier at all — zero tool_results rows,
      // and the notebook (which `writeBrief` only touches on the brief path) is untouched.
      const results = await sql`select 1 from tool_results where conversation_id = ${s.conversationId}`
      expect(results).toHaveLength(0)
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb).toEqual(emptyNotebook())
    })
  })

  it('a supplier failure fails the turn as provider_down, with the Jev call already debited', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const flights = new MockSupplier({ kind: 'flight' })
      vi.spyOn(flights, 'search').mockRejectedValue(new Error('kiwi: HTTP 503'))
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse(tokyo))
      const step = await makeIntake(deps(sql, fetchImpl, flights))(ctx(s, MSG))

      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('provider_down')
      expect(step.recordedMicros).toBeGreaterThan(0n)

      // The intake model_calls row was written, and its cost already landed on
      // conversations.spend_usd_micros — `fail` carries no `costMicros` for the worker to debit.
      const [mc] = await sql<{ cost_micros: string }[]>`
        select cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(BigInt(mc!.cost_micros)).toBe(step.recordedMicros)
      const [c] = await sql`select spend_usd_micros, desk from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(step.recordedMicros)
      // Fix round 1: desk stays 'front' on any throw after the intake call — a retry of the
      // SAME message must see the same front door, not a conversation stranded at 'planning'
      // with no notebook and no results.
      expect(c!.desk).toBe('front')
      // No corpus row for a search that never actually returned anything usable.
      const results = await sql`select 1 from tool_results where conversation_id = ${s.conversationId}`
      expect(results).toHaveLength(0)
      // The attempt itself still left its mark: `beginToolCall` ran before the search threw, and
      // nothing ever reached `finishToolCall` to mark it done.
      const toolCalls = await sql<{ status: string }[]>`select status from tool_calls where turn_id = ${s.turnId}`
      expect(toolCalls).toEqual([{ status: 'pending' }])
    })
  })

  it('a rank fixture that throws fails the turn as fetch_failed, desk still front, zero results rows, cost carried', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      const flights = new MockSupplier({ kind: 'flight' }) // default count: 5, so rerank runs
      const searchSpy = vi.spyOn(flights, 'search')
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jevResponse(tokyo))
        .mockRejectedValueOnce(new Error('jev: 529'))
      const step = await makeIntake(deps(sql, fetchImpl, flights))(ctx(s, MSG))

      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('fetch_failed')
      expect(step.recordedMicros).toBeGreaterThan(0n)
      expect(searchSpy).toHaveBeenCalledTimes(1) // the search itself succeeded; the RERANK call failed

      // Only the intake call ever recorded (the rerank call threw before recordJevCall for that
      // seat could run) — cost carried is exactly that one call's cost.
      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(calls.map((r) => r.seat)).toEqual(['intake'])
      expect(step.recordedMicros).toBe(BigInt(calls[0]!.cost_micros))
      const [c] = await sql`select spend_usd_micros, desk from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(step.recordedMicros)
      expect(c!.desk).toBe('front')

      // recordResults is the LAST write on the success path, after the rerank succeeds — a
      // throw in the rerank call must leave the corpus exactly as empty as it started.
      const results = await sql`select 1 from tool_results where conversation_id = ${s.conversationId}`
      expect(results).toHaveLength(0)
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb).toEqual(emptyNotebook())
      // The search's own tool_calls row IS done (the search succeeded); only what happened
      // after it is undone.
      const toolCalls = await sql<{ status: string }[]>`select status from tool_calls where turn_id = ${s.turnId}`
      expect(toolCalls).toEqual([{ status: 'done' }])
    })
  })

  it('a conversation at the per-turn supplier cap fails as limit_reached without calling the supplier', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      for (let i = 0; i < DEFAULT_LIMITS.maxSupplierCallsPerTurn; i++) {
        await sql`insert into tool_calls (turn_id, call_id, name, status)
                  values (${s.turnId}, ${'seed-' + i}, 'explore_flights', 'done')`
      }
      const flights = new MockSupplier({ kind: 'flight' })
      const searchSpy = vi.spyOn(flights, 'search')
      const fetchImpl = vi.fn().mockResolvedValueOnce(jevResponse(tokyo))
      const step = await makeIntake(deps(sql, fetchImpl, flights))(ctx(s, MSG))

      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('limit_reached')
      expect(step.recordedMicros).toBeGreaterThan(0n)
      expect(searchSpy).not.toHaveBeenCalled()

      const [c] = await sql`select spend_usd_micros, desk from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(step.recordedMicros)
      expect(c!.desk).toBe('front')
      const results = await sql`select 1 from tool_results where conversation_id = ${s.conversationId}`
      expect(results).toHaveLength(0)
    })
  })
})
