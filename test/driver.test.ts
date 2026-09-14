import { expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeDriver } from '../src/agents/driver.js'
import { runTurn } from '../src/worker.js'
import { submitMessage } from '../src/handler.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { recordResults } from '../src/repo/toolResults.js'
import { applyRequirementsPatch, loadNotebook, renderNotebook } from '../src/repo/notebook.js'
import { sanitizeSourceId, maskIdChars } from '../src/sanitize.js'
import { estimateMicros, reconcile, reserve } from '../src/repo/reservation.js'
import { SEATS } from '../src/model/seats.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { APIConnectionError, BadRequestError } from '@anthropic-ai/sdk'
import type { FlightSearch } from '../src/supplier/types.js'
import { LogNotifier } from '../src/notify.js'

const usage = {
  input_tokens: 1000, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 50,
}

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_1', usage,
})

const toolResponse = (name: string, input: unknown) => ({
  content: [
    { type: 'thinking', thinking: 'deciding', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name, input },
  ],
  stop_reason: 'tool_use', model: 'claude-opus-5', _request_id: 'req_2', usage,
})

// The reviewer's own usage (test/reviewer.test.ts): 40 output tokens, not the
// driver's 50 above — reviewOffer prices on THIS response, and 1000*5 + 40*25
// is exactly the 6_000n asserted below.
const reviewerUsage = {
  input_tokens: 1000, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 40,
}
const verdictResponse = (v: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn',
  model: 'claude-opus-5', _request_id: 'req_r', usage: reviewerUsage,
})

type Seeded = { userId: string; conversationId: string; turnId: string }

describeDb('driver', () => {
  const seed = async (sql: postgres.Sql, n: string): Promise<Seeded> => {
    const userId = `00000000-0000-4000-8000-0000000007${n}`
    const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
    const [t] = await sql`
      insert into turns (conversation_id, user_id, idempotency_key, status)
      values (${c!.id}, ${userId}, ${'d' + n}, 'running') returning id`
    return { userId, conversationId: c!.id as string, turnId: t!.id as string }
  }
  const ctx = (s: Seeded) => ({
    state: {
      step: 0,
      messages: [{ role: 'user' as const,
                   content: [{ type: 'text' as const, text: 'a week in Faro' }] }],
    },
    conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
  })
  const deps = (sql: postgres.Sql, create: (req: unknown) => Promise<unknown>) => ({
    sql,
    transport: { create },
    flights: new MockSupplier({ kind: 'flight' }),
    hotels: new MockSupplier({ kind: 'hotel' }),
    limits: DEFAULT_LIMITS,
    now: () => Date.now(),
    notifier: new LogNotifier(() => {}),
  })

  it('returns a message step, writes a model_calls row, and charges NOTHING twice', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const create = vi.fn().mockResolvedValue(textResponse('Faro in September, then.'))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      expect(step.kind).toBe('message')
      if (step.kind !== 'message') throw new Error('unreachable')
      expect(step.text).toContain('Faro')
      // The DRIVER owns the ledger: it reserved and reconciled, so the worker
      // must not charge it again. Both halves are asserted, because either one
      // alone would pass against a driver that charged twice.
      expect(step.costMicros).toBe(0n)
      expect(step.recordedMicros!).toBe(6_250n)   // 1000 in * 5 + 50 out * 25
      const [row] = await sql`
        select seat, capture_policy, cost_micros, thinking_mode, prompt_version
          from model_calls where conversation_id = ${s.conversationId}`
      expect(row!.seat).toBe('driver')
      expect(row!.capture_policy).toBe('full')   // the driver is never sampled out
      expect(row!.thinking_mode).toBe('adaptive')
      expect(row!.prompt_version).toBe('driver@3')
      expect(BigInt(row!.cost_micros as string)).toBe(step.recordedMicros!)
    })
  })

  it('stores the ACTUAL request the transport received as request_shape, not a reconstruction', async () => {
    // This is the branch's headline property (spec section 7's drift clause),
    // and every other request_shape test (test/modelCalls.test.ts) hand-builds
    // `requestShape: { model: 'claude-opus-5' }` and calls `recordModelCall`
    // directly — none of them go through the driver, so none of them would
    // catch the driver writing a fabricated shape instead of the real one.
    // `create.mock.calls[0][0]` is exactly what `callModel` (src/model/client.ts)
    // handed the transport, since `transport.create(buildRequest(args), ...)` is
    // the only call the mock ever receives — comparing against it, not against a
    // hand-built literal, is what makes this test able to catch a driver that
    // stops passing the real assembled request.
    await withTestDb(async (sql) => {
      const s = await seed(sql, '26')
      const create = vi.fn().mockResolvedValue(textResponse('Faro in September, then.'))
      await makeDriver(deps(sql, create))(ctx(s))
      expect(create.mock.calls.length).toBe(1)
      const sentRequest = create.mock.calls[0]![0]
      const [row] = await sql<{ request_shape: unknown }[]>`
        select request_shape from model_calls where conversation_id = ${s.conversationId}`
      expect(row!.request_shape).toEqual(sentRequest)
    })
  })

  it('reserves BEFORE the call and reconciles after, leaving the real cost', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      let spendDuringCall: bigint | null = null
      const create = vi.fn().mockImplementation(async () => {
        const [c] = await sql`
          select spend_usd_micros from conversations where id = ${s.conversationId}`
        spendDuringCall = BigInt(c!.spend_usd_micros as string)
        return textResponse('ok')
      })
      const step = await makeDriver(deps(sql, create))(ctx(s))
      const [after] = await sql`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      const finalSpend = BigInt(after!.spend_usd_micros as string)
      // The reservation is an upper bound assuming a full max_tokens of output,
      // so it must exceed the actual cost of a 50-token response...
      expect(spendDuringCall).not.toBeNull()
      expect(spendDuringCall!).toBeGreaterThan(finalSpend)
      // ...and the reconcile must refund down to the real figure, not accumulate.
      expect(finalSpend).toBe(6_250n)
      expect(finalSpend).toBe(step.recordedMicros!)
    })
  })

  it('reconciles onto the SAME daily bucket the reservation landed on', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      const create = vi.fn().mockResolvedValue(textResponse('ok'))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // `reserve` returns the day it wrote; `reconcile` must be called with THAT
      // day and never with a freshly computed "today". A driver that recomputes
      // it reconciles a call in flight across UTC midnight against the wrong
      // bucket — the reservation lands on yesterday and the refund on today,
      // undercounting today by up to a whole driver reservation.
      const rows = await sql`
        select day::text as day, cost_micros from daily_usage where user_id = ${s.userId}`
      expect(rows.length).toBe(1)
      expect(BigInt(rows[0]!.cost_micros as string)).toBe(step.recordedMicros!)
    })
  })

  it('reconciles against the day RESERVE returned, never a recomputed "today"', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '15')
      // The only way to observe the difference without waiting for UTC midnight:
      // make `reserve` report a day that is not today, and watch which day
      // reaches `reconcile`. A driver that recomputes the day passes today's
      // here and, in production, refunds a midnight-crossing call against a
      // bucket it never reserved on — the reservation lands on yesterday
      // (overcount, safe) and the refund on today (UNDERCOUNT, unsafe).
      const RESERVED_DAY = '2020-01-05'
      const seen: string[] = []
      vi.resetModules()
      const real = await import('../src/repo/reservation.js')
      vi.doMock('../src/repo/reservation.js', () => ({
        ...real,
        reserve: async (...a: Parameters<typeof real.reserve>) =>
          ({ ...(await real.reserve(...a)), day: RESERVED_DAY }),
        reconcile: async (...a: Parameters<typeof real.reconcile>) => {
          seen.push(a[1].day)
          return await real.reconcile(...a)
        },
      }))
      try {
        const { makeDriver: freshDriver } = await import('../src/agents/driver.js')
        const create = vi.fn().mockResolvedValue(textResponse('ok'))
        const step = await freshDriver(deps(sql, create))(ctx(s))
        expect(step.kind).toBe('message')
        expect(seen).toEqual([RESERVED_DAY])
      } finally {
        vi.doUnmock('../src/repo/reservation.js')
        vi.resetModules()
      }
    })
  })

  it('FAILS the turn on a refusal and consumes no quota', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '04')
      const create = vi.fn().mockResolvedValue({
        content: [], stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
        model: 'claude-opus-5', usage,
      })
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // Spec section 8: "A refused driver call FAILS THE TURN with words she can
      // act on and DOES NOT CONSUME QUOTA." Parking here would record the turn
      // as done with fail_reason null, and 'refused' would keep its distinction
      // of being a FailReason no code ever writes.
      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('refused')
      expect(step.message.length).toBeGreaterThan(0)
      expect(step.recordedMicros).toBe(0n)
      // The reservation was debited before dispatch and must be refunded whole.
      const [conv] = await sql`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(conv!.spend_usd_micros as string)).toBe(0n)
      const [daily] = await sql`
        select cost_micros from daily_usage where user_id = ${s.userId}`
      expect(BigInt(daily!.cost_micros as string)).toBe(0n)
      // ...and the refusal is still a row in the ledger, not silence.
      const [row] = await sql`
        select response, cost_micros from model_calls where conversation_id = ${s.conversationId}`
      expect(row!.response).toMatchObject({ stop_reason: 'refusal' })
      expect(BigInt(row!.cost_micros as string)).toBe(0n)
    })
  })

  it('parks on ask_user, with her questions in the message', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '05')
      const create = vi.fn().mockResolvedValue(
        toolResponse('ask_user', { questions: ['Which week?', 'How many of you?'] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // ask_user is terminal by construction: there is nothing to hand back to
      // the model, because the answer comes from her.
      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toContain('Which week?')
      expect(step.message).toContain('How many of you?')
      expect(step.costMicros).toBe(0n)
      expect(step.recordedMicros).toBe(6_250n)
    })
  })

  it('returns a tool step keyed on the PROVIDER id, carrying the assistant turn', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '06')
      const create = vi.fn().mockResolvedValue(toolResponse('explore_flights',
        { from: 'BER', to: 'FAO', departureDate: '2026-09-12', adults: 2 }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      expect(step.callId).toBe('toolu_1')     // the PROVIDER's id, so replay works
      expect(step.name).toBe('explore_flights')
      expect(step.costMicros).toBe(0n)
      expect(step.recordedMicros).toBe(6_250n)
      // The thinking + tool_use blocks must ride back into the transcript, or
      // the next request carries a tool_result with no matching tool_use.
      expect(step.assistantContent).toEqual([
        { type: 'thinking', thinking: 'deciding', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'explore_flights',
          input: { from: 'BER', to: 'FAO', departureDate: '2026-09-12', adults: 2 } },
      ])
      const out = await step.run()
      // api-door results arrive fenced, and the corpus is written so a later
      // propose_itinerary can rehydrate them.
      expect(String(out)).toContain('trust="untrusted"')
      expect(String(out)).toContain('MOCK-flight-')
      const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from tool_results
         where conversation_id = ${s.conversationId}`
      expect(row!.count).toBeGreaterThan(0)
    })
  })

  it('answers ONE tool call and does not echo an unanswered sibling tool_use', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '17')
      const create = vi.fn().mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'deciding', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_1', name: 'ask_user', input: { questions: ['Which week?'] } },
          { type: 'tool_use', id: 'toolu_2', name: 'explore_hotels',
            input: { query: 'Faro', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2 } },
        ],
        stop_reason: 'tool_use', model: 'claude-opus-5', _request_id: 'req_3', usage,
      })
      const create2 = vi.fn().mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'explore_flights',
            input: { from: 'BER', to: 'FAO', departureDate: '2026-09-12', adults: 2 } },
          { type: 'tool_use', id: 'toolu_2', name: 'explore_hotels',
            input: { query: 'Faro', checkIn: '2026-09-12', checkOut: '2026-09-19', adults: 2 } },
        ],
        stop_reason: 'tool_use', model: 'claude-opus-5', _request_id: 'req_4', usage,
      })
      // Parallel tool use is on by default and `buildRequest` sends no
      // `tool_choice`, so two tool_use blocks in one response are legal. An
      // AgentStep answers exactly one of them, and `loop()` appends
      // assistantContent followed by a SINGLE tool_result — so echoing the
      // sibling would put an unanswered tool_use into the next request, which
      // is a 400 and a dead turn.
      const first = await makeDriver(deps(sql, create))(ctx(s))
      expect(first.kind).toBe('park')          // the first block wins, whatever it is

      const s2 = await seed(sql, '18')
      const step = await makeDriver(deps(sql, create2))(ctx(s2))
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      expect(step.callId).toBe('toolu_1')
      const echoed = step.assistantContent!.filter((b) => b.type === 'tool_use')
      expect(echoed.length).toBe(1)
      expect(echoed[0]).toMatchObject({ id: 'toolu_1' })
    })
  })

  it('hands back a readable rejection instead of throwing on bad tool input', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07')
      const create = vi.fn().mockResolvedValue(
        toolResponse('ask_user', { questions: 'not an array' }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // A rejection travels the same durable path as a result: it is a tool step
      // whose run() resolves to text, so tool_calls records the attempt and the
      // model gets one round trip to fix it.
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      expect(String(await step.run())).toContain('questions')
    })
  })

  it('refuses a supplier call once the per-turn budget is spent', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '08')
      for (let i = 0; i < DEFAULT_LIMITS.maxSupplierCallsPerTurn; i++) {
        await sql`insert into tool_calls (turn_id, call_id, name, status)
                  values (${s.turnId}, ${'pre' + i}, 'explore_flights', 'done')`
      }
      const create = vi.fn().mockResolvedValue(toolResponse('explore_flights',
        { from: 'BER', to: 'FAO', departureDate: '2026-09-12', adults: 2 }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // The budget is spent, so the model gets a readable refusal it can act on
      // rather than another supplier call.
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      const result = String(await step.run())
      expect(result).toMatch(/budget|limit|searches/i)
      expect(result).toContain(String(DEFAULT_LIMITS.maxSupplierCallsPerTurn))
      // ...and nothing was actually searched.
      const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from tool_results
         where conversation_id = ${s.conversationId}`
      expect(row!.count).toBe(0)
    })
  })

  it('counts hand_off_to_booking against the same per-turn supplier budget, though it is a code-door tool', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '28')
      for (let i = 0; i < DEFAULT_LIMITS.maxSupplierCallsPerTurn; i++) {
        await sql`insert into tool_calls (turn_id, call_id, name, status)
                  values (${s.turnId}, ${'pre' + i}, 'explore_flights', 'done')`
      }
      const create = vi.fn().mockResolvedValue(toolResponse('hand_off_to_booking',
        { proposalId: '00000000-0000-4000-8000-000000000001' }))
      const d = deps(sql, create)
      const qf = vi.spyOn(d.flights, 'quote')
      const step = await makeDriver(d)(ctx(s))
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      const result = String(await step.run())
      // The budget refusal, same as any other supplier-reaching tool — never
      // the cashier's own "no proposal"/"not been accepted" text, which would
      // mean the gate was skipped and handOff ran instead.
      expect(result).toMatch(/budget|limit|searches/i)
      expect(result).toContain(String(DEFAULT_LIMITS.maxSupplierCallsPerTurn))
      // ...and no supplier was ever asked to re-quote.
      expect(qf).not.toHaveBeenCalled()
    })
  })

  it('records update_requirements into the notebook, as HER words', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '09')
      const create = vi.fn().mockResolvedValue(toolResponse('update_requirements',
        { patch: { destination: 'Faro', nights: 7,
                   budget: { minor: '180000', currency: 'EUR' } } }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      expect(out).toContain('Faro')
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      // Persisted, not just echoed. `conversations.requirements` had no writer
      // in the entire repository before this task.
      expect(nb.destination!.value).toBe('Faro')
      expect(nb.nights!.value).toBe(7)
      expect(nb.budget!.value.minor).toBe(180_000n)
      // Spec section 4: her stated facts are hers, so she can change them later.
      expect(nb.destination!.source).toBe('user')
    })
  })

  it('tells the model which keys of an update_requirements patch were refused', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '10')
      const create = vi.fn().mockResolvedValue(toolResponse('update_requirements',
        { patch: { nights: 7, elopement: true } }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      // An unknown key rejects the WHOLE patch (src/notebook.ts), so the model
      // must be told the name it invented rather than left believing `nights`
      // landed.
      expect(out).toContain('elopement')
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb.nights).toBeNull()
    })
  })

  it('will not let a patch made AFTER a supplier result relax what she set', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '19')
      await applyRequirementsPatch(sql, {
        conversationId: s.conversationId, userId: s.userId, source: 'user',
        patch: { maxStops: 0 },
      })
      const create = vi.fn().mockResolvedValue(toolResponse('update_requirements',
        { patch: { maxStops: 3 } }))
      // A transcript that has already ingested a supplier payload. `loop()`
      // hydrates a fresh turn from `messages` as role + text only, so a
      // tool_result block can only mean THIS turn ran a tool — the model is no
      // longer transcribing her words, it is reacting to a listing. Stamped
      // 'user', this patch would relax a constraint by a number the MODEL chose
      // and hand it to the money gate.
      const tainted = {
        state: {
          step: 1,
          messages: [
            { role: 'user' as const,
              content: [{ type: 'text' as const, text: 'a week in Faro, direct flights only' }] },
            { role: 'assistant' as const,
              content: [{ type: 'tool_use' as const, id: 'toolu_0',
                          name: 'explore_flights', input: {} }] },
            { role: 'user' as const,
              content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_0',
                          content: 'MOCK-flight-1 — cheapest has 2 stops' }] },
          ],
        },
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId,
      }
      const step = await makeDriver(deps(sql, create))(tainted)
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      expect(out).toContain('maxStops')            // the model is told, and why
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb.maxStops!.value).toBe(0)           // unchanged in the DATABASE
      expect(nb.maxStops!.source).toBe('user')     // and still HERS
    })
  })

  it('still records her own words as hers on an untainted transcript', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '20')
      await applyRequirementsPatch(sql, {
        conversationId: s.conversationId, userId: s.userId, source: 'user',
        patch: { maxStops: 0 },
      })
      const create = vi.fn().mockResolvedValue(toolResponse('update_requirements',
        { patch: { maxStops: 2 } }))
      // The other side of the boundary. Step 0 of every turn is provably her
      // words alone, so she can relax anything she likes — a guard that blocked
      // this too would mean she could never change her mind, which is not a
      // defence, it is a bug.
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      await step.run()
      const nb = await loadNotebook(sql, s.conversationId, s.userId)
      expect(nb.maxStops!.value).toBe(2)
      expect(nb.maxStops!.source).toBe('user')
    })
  })

  it('refunds the whole reservation when the provider answered with an ERROR body', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '21')
      const create = vi.fn().mockRejectedValue(
        new BadRequestError(400, { type: 'error' }, 'bad request', new Headers()))
      // An error response carries no `usage`, so nothing was billed. This holds
      // for 429s and 5xx too — the whole point of classifying on "did a response
      // body reach us?" rather than on retryability, since an outage produces
      // exactly the retryable ones and stranding THOSE reservations is what
      // takes the global ceiling down at zero real spend.
      await expect(makeDriver(deps(sql, create))(ctx(s))).rejects.toThrow()
      const [conv] = await sql`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(conv!.spend_usd_micros as string)).toBe(0n)
      const [daily] = await sql`
        select cost_micros from daily_usage where user_id = ${s.userId}`
      expect(BigInt(daily!.cost_micros as string)).toBe(0n)
    })
  })

  it('KEEPS the reservation when no response reached us at all', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '22')
      const create = vi.fn().mockRejectedValue(new APIConnectionError({ message: 'socket hang up' }))
      // Fail closed: the provider may have generated and billed a response we
      // never saw, so the debit stands. The floor below is the output half of
      // the reservation alone (max_tokens at the seat's output rate), which no
      // prompt-size difference can move.
      await expect(makeDriver(deps(sql, create))(ctx(s))).rejects.toThrow()
      const floor = estimateMicros(SEATS.driver, 0)
      expect(floor).toBe(400_000n)                 // 16,000 max_tokens * 25 micros
      const [conv] = await sql`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(conv!.spend_usd_micros as string)).toBeGreaterThanOrEqual(floor)
      const [daily] = await sql`
        select cost_micros from daily_usage where user_id = ${s.userId}`
      expect(BigInt(daily!.cost_micros as string)).toBeGreaterThanOrEqual(floor)
    })
  })

  it('sends the notebook to the model AFTER the cache breakpoint', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '11')
      await applyRequirementsPatch(sql, {
        conversationId: s.conversationId, userId: s.userId, source: 'user',
        patch: { destination: 'Faro' },
      })
      let sent: Record<string, unknown> | null = null
      const create = vi.fn().mockImplementation(async (req: unknown) => {
        sent = req as Record<string, unknown>
        return textResponse('ok')
      })
      await makeDriver(deps(sql, create))(ctx(s))
      const messages = sent!.messages as Array<{ content: Array<Record<string, unknown>> }>
      const lastBlock = messages.at(-1)!.content.at(-1)!
      expect(String(lastBlock.text)).toContain('Faro')
      // It changes every turn, so anything cached behind it would be
      // invalidated on every request (spec section 7).
      expect(lastBlock.cache_control).toBeUndefined()
      // ...and the tools the desk advertises are all on the wire.
      const names = (sent!.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names).toContain('update_requirements')
      expect(names).toContain('propose_itinerary')
    })
  })

  // The price half of `trimForContext` (spec section 4), implemented as a
  // warning in the suffix rather than in the tool result itself: the model
  // reads it BEFORE it proposes, not after a rejection. `deps.now` is the real
  // `Date.now()` (see `deps` above), so the corpus row must be stale against
  // WALL-CLOCK time — seeding its `fetchedAt` 30 minutes in the past, well
  // past the mock supplier's 900-second (15-minute) ttl, achieves that
  // without a fake clock.
  it('appends an expired-results notice to the suffix when the corpus holds a stale batch', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '30')
      const staleParams: FlightSearch = {
        kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
        returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
        cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
      }
      const items = await new MockSupplier({
        kind: 'flight', now: () => new Date(Date.now() - 30 * 60_000),
      }).search(staleParams)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: null, params: staleParams, items,
      })
      let sent: Record<string, unknown> | null = null
      const create = vi.fn().mockImplementation(async (req: unknown) => {
        sent = req as Record<string, unknown>
        return textResponse('ok')
      })
      await makeDriver(deps(sql, create))(ctx(s))
      const messages = sent!.messages as Array<{ content: Array<Record<string, unknown>> }>
      const lastBlock = messages.at(-1)!.content.at(-1)!
      const text = String(lastBlock.text)
      // `lastBlock` IS the last content block of the last message — the
      // notice, being part of `suffix`, always lands there (src/model/client.ts's
      // `withSuffix`).
      expect(text).toContain('## Expired results')
      for (const i of items) expect(text).toContain(maskIdChars(i.sourceId))
    })
  })

  // M10: seeds a FRESH batch, not an empty corpus — a corpus with zero rows
  // trivially has zero expired ones, which exercises nothing about the
  // "nothing is stale" branch of listExpiredSourceIds. A batch that is
  // present and genuinely fresh (fetchedAt now, well inside its ttl) is the
  // real case this test claims to cover.
  it('omits the expired-results notice entirely when nothing in the corpus is stale', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '31')
      const freshParams: FlightSearch = {
        kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
        returnDate: null, flexDays: 0, adults: 2, children: 0, infants: 0,
        cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
      }
      const freshItems = await new MockSupplier({ kind: 'flight' }).search(freshParams)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: null, params: freshParams, items: freshItems,
      })
      // A non-empty notebook, so the suffix is non-empty either way — an
      // empty notebook would make the "notice dropped out entirely" case
      // indistinguishable from "the suffix was never appended at all"
      // (`withSuffix` skips appending anything when `suffix.length === 0`).
      await applyRequirementsPatch(sql, {
        conversationId: s.conversationId, userId: s.userId, source: 'user',
        patch: { destination: 'Faro' },
      })
      let sent: Record<string, unknown> | null = null
      const create = vi.fn().mockImplementation(async (req: unknown) => {
        sent = req as Record<string, unknown>
        return textResponse('ok')
      })
      await makeDriver(deps(sql, create))(ctx(s))
      const messages = sent!.messages as Array<{ content: Array<Record<string, unknown>> }>
      const lastBlock = messages.at(-1)!.content.at(-1)!
      const text = String(lastBlock.text)
      expect(text).not.toContain('## Expired results')
      // With nothing expired, the suffix block is the rendered notebook alone.
      const notebook = await loadNotebook(sql, s.conversationId, s.userId)
      expect(text).toBe(renderNotebook(notebook))
    })
  })

  it('runs propose_itinerary through the gates and reports a pass', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '12')
      const params: FlightSearch = {
        kind: 'flight', from: 'BER', to: 'FAO', departureDate: '2026-09-12',
        returnDate: '2026-09-19', flexDays: 0, adults: 2, children: 0, infants: 0,
        cabinClass: 'Economy', currency: 'EUR', maxStops: null, allowSelfTransfer: false,
      }
      const items = await new MockSupplier({ kind: 'flight' }).search(params)
      await recordResults(sql, {
        conversationId: s.conversationId, userId: s.userId, turnId: s.turnId, params, items,
      })
      const create = vi.fn()
        .mockResolvedValueOnce(toolResponse('propose_itinerary',
          { refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }] }))
        .mockResolvedValueOnce(verdictResponse({ approved: true, issues: [] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      expect(out).toMatch(/approved/i)
      expect(out).toContain(items[0]!.sourceId)
      expect(out).toContain('proposal_id')
      const rows = await sql`
        select gate, passed from gate_results where conversation_id = ${s.conversationId}`
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((r) => r.gate === 'provenance' && r.passed === true)).toBe(true)
      const proposals = await sql`select 1 from proposals where conversation_id = ${s.conversationId}`
      expect(proposals).toHaveLength(1)
      expect(step.spent!.micros).toBe(6_000n)
      // M1: `created_at` is transaction-start time inside withTestDb (every
      // insert in this test transaction gets the SAME timestamp), so ordering
      // by it and asserting an exact sequence is asserting on Postgres's tie-
      // breaking, not on anything the driver guarantees. A multiset assertion
      // pins what actually matters: both seats fired, exactly once each.
      const calls = await sql`
        select seat from model_calls where conversation_id = ${s.conversationId}`
      expect(new Set(calls.map((r) => r.seat))).toEqual(new Set(['driver', 'reviewer']))
      expect(calls).toHaveLength(2)
    })
  })

  // IMPORTANT 2: driver.md instructs the model to "fix exactly what it names
  // and propose again" on rejection, so a second propose_itinerary in the same
  // turn is not an edge case. round used to be hardcoded to 0 on every call,
  // so two proposals in a turn wrote two identical seven-row gate_results sets
  // under round 0, double-counting any `group by gate` fire-rate query.
  it('derives round from the count of PRIOR gate-running tool calls this turn, not a hardcoded 0', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '23')
      // Stands in for a first propose_itinerary call this turn: `loop()`
      // writes exactly this row (beginToolCall) BEFORE the tool runs, so by the
      // time a real second call reaches this handler, a prior round's row
      // already exists under a DIFFERENT call_id.
      await sql`
        insert into tool_calls (turn_id, call_id, name, status)
        values (${s.turnId}, 'toolu_0', 'propose_itinerary', 'done')`
      const create = vi.fn().mockResolvedValue(toolResponse('propose_itinerary',
        { refs: [{ sourceId: 'INVENTED-1', quantity: 1, slot: 'outbound' }] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      await step.run()
      const rows = await sql`
        select distinct round from gate_results where conversation_id = ${s.conversationId}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.round).toBe(1)
    })
  })

  // The one call_id this handler must NOT count against itself: `loop()`
  // (src/worker.ts) writes THIS call's own tool_calls row via beginToolCall
  // before execute() runs, so without the `call_id != callId` exclusion every
  // call — even the first — would count itself and start at round 1.
  it('does not count its OWN in-progress tool_calls row as a prior gate run', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '24')
      await sql`
        insert into tool_calls (turn_id, call_id, name, status)
        values (${s.turnId}, 'toolu_1', 'propose_itinerary', 'pending')`
      const create = vi.fn().mockResolvedValue(toolResponse('propose_itinerary',
        { refs: [{ sourceId: 'INVENTED-1', quantity: 1, slot: 'outbound' }] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      await step.run()
      const [row] = await sql`
        select distinct round from gate_results where conversation_id = ${s.conversationId}`
      expect(row!.round).toBe(0)
    })
  })

  it('reports a provenance failure back to the model in words it can act on', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '13')
      const create = vi.fn().mockResolvedValue(toolResponse('propose_itinerary',
        { refs: [{ sourceId: 'INVENTED-1', quantity: 1, slot: 'outbound' }] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      // The single most valuable failure in the suite: a hallucinated source id
      // must come back as a correctable message, not a thrown turn.
      expect(out).toMatch(/rejected/i)
      expect(out).toContain('INVENTED-1')
      expect(out).toContain('provenance')
      const [row] = await sql`
        select passed from gate_results
         where conversation_id = ${s.conversationId} and gate = 'provenance'`
      expect(row!.passed).toBe(false)
    })
  })

  // IMPORTANT 10: `sourceId` is echoed back into the model's own context
  // verbatim on a rejection, and `ProposalRefsSchema` allows up to 512
  // arbitrary characters — including a newline, which would otherwise let a
  // crafted id inject what reads as a new line of instructions into the tool
  // result. Escaping and capping the id must not fence the surrounding "fix
  // exactly what it names and propose again" instruction.
  it('escapes and caps a hostile sourceId before echoing it back, without fencing the instruction', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '25')
      const hostile = `INV\n${'X'.repeat(200)}`   // a newline, and over the 128-char cap
      const create = vi.fn().mockResolvedValue(toolResponse('propose_itinerary',
        { refs: [{ sourceId: hostile, quantity: 1, slot: 'outbound' }] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      expect(out).toMatch(/rejected/i)
      expect(out).toMatch(/fix exactly these and propose again/i)
      // The sanitized ids sit in the "(...)" segment driver.ts itself builds
      // (`v.sourceIds.map(sanitizeSourceId).join(', ')`), which is what this
      // finding scopes — NOT the violation's `detail` text, built upstream in
      // src/gates/rehydrateGate.ts, which still echoes the raw id and is a
      // separate, out-of-scope surface.
      const idsSegment = out.match(/\(([\s\S]*?)\):/)?.[1]
      expect(idsSegment).toBeDefined()
      expect(idsSegment).not.toContain('\n')      // the raw newline must not survive
      expect(idsSegment).toContain('INV?')        // escaped, not dropped
      expect(idsSegment).toContain('…')            // truncated past 128 chars, marker intact
      expect(idsSegment!.length).toBeLessThan(hostile.length)
    })
  })

  it('fails the turn when the reservation carries the conversation past its ceiling', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '14')
      await sql`update conversations
                   set spend_usd_micros = ${(DEFAULT_LIMITS.conversationCeilingMicros - 1n).toString()}
                 where id = ${s.conversationId}`
      const create = vi.fn().mockResolvedValue(textResponse('never sent'))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // The check reads the value `reserve` RETURNED, so the reservation this
      // very call just made counts against the ceiling. A driver that checked a
      // counter read before the turn began would have dispatched here.
      expect(create).not.toHaveBeenCalled()
      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('limit_reached')
      expect(step.recordedMicros).toBe(0n)
      // ...and the reservation it made to discover that is refunded whole.
      const [conv] = await sql`
        select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(conv!.spend_usd_micros as string))
        .toBe(DEFAULT_LIMITS.conversationCeilingMicros - 1n)
    })
  })

  it('fails the turn when the reservation carries the DAY past its ceiling', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '16')
      await sql`
        insert into daily_usage (user_id, day, cost_micros)
        values (${s.userId}, (now() at time zone 'utc')::date,
                ${(DEFAULT_LIMITS.dailyCeilingMicros - 1n).toString()})`
      const create = vi.fn().mockResolvedValue(textResponse('never sent'))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      // `reserve` returns the daily total too, and a ceiling nobody compares
      // against is not a ceiling. The conversation is nowhere near its own cap
      // here, so only the daily check can stop this call.
      expect(create).not.toHaveBeenCalled()
      expect(step.kind).toBe('fail')
      if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('limit_reached')
      // The two ceilings are answered differently: a new conversation fixes one
      // and does nothing for the other, so the message must not claim it does.
      expect(step.message).toMatch(/today/i)
      expect(step.message).not.toMatch(/start a new conversation/i)
      const [daily] = await sql`
        select cost_micros from daily_usage
         where user_id = ${s.userId} and day = (now() at time zone 'utc')::date`
      expect(BigInt(daily!.cost_micros as string)).toBe(DEFAULT_LIMITS.dailyCeilingMicros - 1n)
    })
  })

  it('through runTurn, charges the conversation exactly ONCE per model call', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000007099'
      const r = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId, conversationId: null, message: 'a week in Faro', idempotencyKey: 'rt1' },
      )
      // This test calls `makeDriver` directly (not `routeAgent`), so the
      // conversation `submitMessage` created at `desk = 'front'` (Task 1) is
      // seeded straight to 'planning' — the desk flag plays no part in what
      // this test is checking (per-model-call spend, exactly once).
      await sql`update conversations set desk = 'planning' where id = ${r.conversationId}`
      const create = vi.fn().mockResolvedValue(textResponse('Faro it is.'))
      await runTurn({
        sql, limits: DEFAULT_LIMITS,
        agent: makeDriver(deps(sql, create)),
        now: () => Date.now(), deadlineMs: () => Date.now() + 600_000,
        reinvoke: async () => {},
      }, r.turnId!)

      const [call] = await sql`
        select cost_micros from model_calls where conversation_id = ${r.conversationId}`
      const [conv] = await sql`
        select spend_usd_micros from conversations where id = ${r.conversationId}`
      const [turn] = await sql`
        select spend_usd_micros from turns where id = ${r.turnId}`
      const [daily] = await sql`
        select cost_micros from daily_usage where user_id = ${userId}`
      // THE test the first draft did not have. Every driver test called
      // makeDriver(deps)(ctx) directly, so the worker's own recordSpend — which
      // performs the identical increment the driver's reserve/reconcile already
      // performed — was invisible, and every model call would have billed 2x.
      expect(BigInt(call!.cost_micros as string)).toBe(6_250n)
      expect(BigInt(conv!.spend_usd_micros as string)).toBe(6_250n)
      expect(BigInt(turn!.spend_usd_micros as string)).toBe(6_250n)
      expect(BigInt(daily!.cost_micros as string)).toBe(6_250n)
    })
  })

  // research_destination's door is 'worker' (src/tools/registry.ts), so its
  // result must arrive fenced like an api-door result — it is a model's prose,
  // paid for, but still untrusted content by the time it reaches the driver's
  // own transcript. The scout's own Haiku call is a SECOND model call within
  // the same tool step, priced and recorded separately from the driver's.
  it('research_destination: fences the brief as untrusted and folds the scout cost into step.spent', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '25')
      const scoutUsage = {
        input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        output_tokens: 200, server_tool_use: { web_search_requests: 1 },
      }
      const create = vi.fn()
        .mockResolvedValueOnce(toolResponse('research_destination', { city: 'Faro' }))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Faro is the gateway to the Algarve.' }],
          stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', _request_id: 'req_scout',
          usage: scoutUsage,
        })
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      expect(step.name).toBe('research_destination')
      const out = String(await step.run())
      expect(out).toContain('trust="untrusted"')
      expect(out).toContain('Faro is the gateway to the Algarve.')
      // 1000*1 (input) + 200*5 (output) + 1*10_000 (one search) = 12_000
      expect(step.spent!.micros).toBe(12_000n)
      const [mc] = await sql`
        select seat, cost_micros from model_calls where turn_id = ${s.turnId} and seat = 'scout'`
      expect(mc!.seat).toBe('scout')
      expect(BigInt(mc!.cost_micros as string)).toBe(12_000n)
    })
  })

  it('counts research_destination against the same per-turn supplier budget, though it is a worker-door tool', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '29')
      for (let i = 0; i < DEFAULT_LIMITS.maxSupplierCallsPerTurn; i++) {
        await sql`insert into tool_calls (turn_id, call_id, name, status)
                  values (${s.turnId}, ${'pre' + i}, 'explore_flights', 'done')`
      }
      const create = vi.fn().mockResolvedValue(toolResponse('research_destination', { city: 'Faro' }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      expect(step.kind).toBe('tool')
      if (step.kind !== 'tool') throw new Error('unreachable')
      const result = String(await step.run())
      expect(result).toMatch(/budget|limit|searches/i)
      expect(result).toContain(String(DEFAULT_LIMITS.maxSupplierCallsPerTurn))
      // The budget gate fires before execute() ever calls the scout, so the
      // shared transport sees only the driver's own call — never a second one
      // for the scout's Haiku request.
      expect(create).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * `reconcile`'s INSERT branch had no caller and no test before this task: every
 * existing reservation test reconciles against a day `reserve` created moments
 * earlier, so the `on conflict` arm is the only one that ever ran. The driver is
 * its first production caller, and the branch it does NOT exercise in a test is
 * exactly the one a UTC-midnight crossing takes — so it is pinned here, next to
 * the caller whose threading of `day` decides which arm fires.
 */
describeDb('reconcile against a day with no prior row', () => {
  it('inserts the day rather than dropping the delta on the floor', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000007200'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      const conversationId = c!.id as string

      // A charge (not a refund) landing on a day that has no daily_usage row.
      await reconcile(sql, {
        userId, conversationId, reserved: 0n, actual: 7_000n, day: '2020-01-02',
      })
      const [inserted] = await sql`
        select cost_micros from daily_usage
         where user_id = ${userId} and day = '2020-01-02'`
      expect(BigInt(inserted!.cost_micros as string)).toBe(7_000n)

      // And a refund against a day that has no row cannot drive it negative.
      await reconcile(sql, {
        userId, conversationId, reserved: 5_000n, actual: 0n, day: '2020-01-03',
      })
      const [refunded] = await sql`
        select cost_micros from daily_usage
         where user_id = ${userId} and day = '2020-01-03'`
      expect(BigInt(refunded!.cost_micros as string)).toBe(0n)
    })
  })

  it('lands the refund on the day the reservation was made, not on "today"', async () => {
    await withTestDb(async (sql) => {
      const userId = '00000000-0000-4000-8000-000000007201'
      const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
      const conversationId = c!.id as string
      const res = await reserve(sql, { userId, conversationId, micros: 400_000n })
      await reconcile(sql, {
        userId, conversationId, reserved: 400_000n, actual: 6_250n, day: res.day,
      })
      const rows = await sql`
        select day::text as day, cost_micros from daily_usage where user_id = ${userId}`
      expect(rows.length).toBe(1)
      expect(rows[0]!.day).toBe(res.day)
      expect(BigInt(rows[0]!.cost_micros as string)).toBe(6_250n)
    })
  })
})
