import { expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeDriver } from '../src/agents/driver.js'
import { runTurn } from '../src/worker.js'
import { submitMessage } from '../src/handler.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { recordResults } from '../src/repo/toolResults.js'
import { applyRequirementsPatch, loadNotebook } from '../src/repo/notebook.js'
import { reconcile, reserve } from '../src/repo/reservation.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

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
      step: 0, reviewRounds: 0,
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
      expect(row!.prompt_version).toBe('driver@1')
      expect(BigInt(row!.cost_micros as string)).toBe(step.recordedMicros!)
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
      const create = vi.fn().mockResolvedValue(toolResponse('propose_itinerary',
        { refs: [{ sourceId: items[0]!.sourceId, quantity: 1, slot: 'outbound' }] }))
      const step = await makeDriver(deps(sql, create))(ctx(s))
      if (step.kind !== 'tool') throw new Error('unreachable')
      const out = String(await step.run())
      expect(out).toMatch(/accepted/i)
      expect(out).toContain(items[0]!.sourceId)
      const rows = await sql`
        select gate, passed from gate_results where conversation_id = ${s.conversationId}`
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.some((r) => r.gate === 'provenance' && r.passed === true)).toBe(true)
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
