import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { ledgerRunner, mockRunner } from '../src/tools.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { apiError } from './helpers/errors.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { claimOf, workerDeps } from './helpers/worker.js'

const USER = randomUUID()

const HER_MESSAGE = 'Portugal in September for 1500 euros'

async function seededTurn(sql: postgres.Sql, text = HER_MESSAGE) {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${c!.id}, ${USER}, ${randomUUID()}) returning id`
  await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content)
    values (${c!.id}, ${USER}, ${t!.id}, 'user', ${text})`
  return { conversationId: c!.id as string, turnId: t!.id as string }
}

describeDb('one invocation of the driver is one model call', () => {
  it('charges the conversation exactly once for a call, through one door', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      const client = fakeClient([textMessage('Three stays near the beach in Faro.')])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [turn] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.turns where id = ${turnId}`
      const [call] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls where turn_id = ${turnId} order by seq`
      // The three have to agree exactly. This is the test that discriminates the
      // double charge: the driver reserves and reconciles its own spend, so a
      // step that also reported costMicros without alreadyRecorded would apply
      // the identical increment a second time and the conversation would read
      // twice the call.
      expect(BigInt(conv!.spend_usd_micros)).toBe(BigInt(call!.cost_micros))
      expect(BigInt(turn!.spend_usd_micros)).toBe(BigInt(call!.cost_micros))
    })
  })

  it('refunds the whole reservation when the model refuses, so a refusal costs nothing', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      const refusal = textMessage('', {
        content: [], stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'policy', explanation: null },
      } as never)
      const agent = makeDriver({
        sql, client: fakeClient([refusal]), run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      // SPEC section 8: a refusal fails the turn and does not consume quota. The
      // counter is back exactly where it started, not merely close to it. Zero
      // is the right figure only while the driver makes exactly one call per
      // step; lesson 5.3 puts a charged routing call in front of step 0 and
      // moves this assertion to that call's cost, in the same commit that adds
      // it, because a refusal refunds its own reservation and not the call that
      // decided where it went.
      expect(BigInt(conv!.spend_usd_micros)).toBe(0n)
      const [row] = await sql<{ fail_reason: string }[]>`
        select fail_reason from course.turns where id = ${turnId}`
      expect(row!.fail_reason).toBe('refused')
    })
  })

  it('strands nothing when every attempt of a step fails, because a 5xx was never billed', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      // A 503, which classifies `provider_down` and is retryable, so `withRetry`
      // (src/retry.ts) gives the step three attempts and each one reserves
      // before it dispatches. `fakeClient` repeats its last entry, so all three
      // attempts get the same outage.
      const client = fakeClient([() => { throw apiError(503) }])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await expect(runTurn(workerDeps(sql, { agent }), turnId)).rejects.toThrow()
      expect(client.calls).toBe(3)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [day] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.daily_usage where user_id = ${USER}`
      // Zero on BOTH ceilings, not "roughly nothing". Three reservations of
      // roughly 400,000 micros each is over a million stranded in a column
      // `readSpendFailClosed` sums across all users for the global ceiling
      // (src/limits.ts), so an outage that failed a few hundred steps would cap
      // the whole product for the rest of the UTC day at zero real spend, with
      // no lever short of a manual write.
      expect(BigInt(conv!.spend_usd_micros)).toBe(0n)
      expect(BigInt(day?.cost_micros ?? '0')).toBe(0n)

      const [turn] = await sql<{ fail_reason: string }[]>`
        select fail_reason from course.turns where id = ${turnId}`
      expect(turn!.fail_reason).toBe('provider_down')
    })
  })

  it('appends the assistant turn carrying the tool_use before the tool_result', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Three stays near the beach in Faro.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [row] = await sql<{ state: { messages: { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[] } }[]>`
        select state from course.turns where id = ${turnId}`
      const messages = row!.state.messages
      // user, assistant(tool_use), user(tool_result). Without the assistant turn
      // in the middle, the tool_result is unpaired and the NEXT request is a 400,
      // which would have been every tool call the system ever made.
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      const use = messages[1]!.content.find((b) => b.type === 'tool_use')!
      const result = messages[2]!.content.find((b) => b.type === 'tool_result')!
      expect(result.tool_use_id).toBe(use.id)
    })
  })

  it('writes one pending row per call and runs the tool once, through the chain tier 3 composes', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Three stays near the beach in Faro.'),
      ])
      let executions = 0
      const inner = mockRunner()
      // The chain as netlify/functions/run-turn-background.mts composes it:
      // `ledgerRunner` OUTERMOST, built per step from the `AgentContext` the
      // harness hands the agent, exactly the way tier 3 builds `runnerFor`.
      // `mockRunner` stands in for the cashier, the gates, the corpus and the
      // supplier, which this case is not about; the counter between the two is
      // how "executed" is told apart from "replayed".
      //
      // Every other case in this file hands the driver a bare `mockRunner()`,
      // which has no ledger in it, so none of them can see what the deployed
      // composition does. This one is the case that can.
      const agent: Agent = async (ctx) => makeDriver({
        sql,
        client,
        run: ledgerRunner(
          sql,
          claimOf(ctx),
          async (name, input, callId, signal) => {
            executions += 1
            return await inner(name, input, callId, signal)
          },
        ),
        limits: DEFAULT_LIMITS,
        now: Date.now,
      })(ctx)
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [turn] = await sql<{ status: string; fail_reason: string | null }[]>`
        select status, fail_reason from course.turns where id = ${turnId}`
      // The turn ANSWERS. A second writer of the pending row makes the first
      // tool call of every deployed turn end `ambiguous_tool_call` with the
      // supplier never called, and leaves an operator ticket behind it.
      expect(turn!.status).toBe('done')
      expect(turn!.fail_reason).toBe(null)
      expect(executions).toBe(1)

      const rows = await sql<{ call_id: string; status: string }[]>`
        select call_id, status from course.tool_calls where turn_id = ${turnId}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('done')
    })
  })

  it('resumes a released turn instead of starting the conversation again', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Three stays near the beach in Faro.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      // One step, then the deadline is behind us, so the harness hands the turn
      // back exactly the way a fifteen minute invocation running out does.
      let stepBudget = 1
      await runTurn(
        workerDeps(sql, {
          agent, deadlineMs: () => (stepBudget-- > 0 ? Date.now() + 600_000 : Date.now() - 1),
        }),
        turnId,
      )
      expect(client.calls).toBe(1)

      const [held] = await sql<{ status: string; state: { messages: unknown[] } }[]>`
        select status, state from course.turns where id = ${turnId}`
      expect(held!.status).toBe('queued')
      // Three lines already, held in the row: her message, what the model said,
      // and what the tool answered.
      expect(held!.state.messages).toHaveLength(3)

      await runTurn(workerDeps(sql, { agent }), turnId)
      // Two calls in total for the whole turn, not four. The second attempt
      // picked up the conversation rather than re-running it, which is the
      // difference between a resume and a restart.
      expect(client.calls).toBe(2)
    })
  })

  it('keys the call on its position, so a re-ask after a lost state write replays it', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql, HER_MESSAGE)
      const search = {
        city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1,
      }
      const client = fakeClient([
        toolUseMessage('search_hotels', search, 'toolu_01FIRST'),
        // The identical request, with the fresh id a real provider mints on
        // every response. This is the reply the re-ask below receives, and it
        // is what makes an id read off the reply useless as a ledger key.
        toolUseMessage('search_hotels', search, 'toolu_02SECOND'),
        textMessage('Three stays near the beach in Faro.'),
      ])
      let executions = 0
      const inner = mockRunner()
      const agent: Agent = async (ctx) => makeDriver({
        sql,
        client,
        run: ledgerRunner(sql, claimOf(ctx), async (name, input, callId, signal) => {
          executions += 1
          return await inner(name, input, callId, signal)
        }),
        limits: DEFAULT_LIMITS,
        now: Date.now,
      })(ctx)

      // One step, then the invocation is out of wall clock and hands the turn
      // back, so the tool has run and been recorded.
      let stepBudget = 1
      await runTurn(
        workerDeps(sql, {
          agent, deadlineMs: () => (stepBudget-- > 0 ? Date.now() + 600_000 : Date.now() - 1),
        }),
        turnId,
      )
      expect(executions).toBe(1)

      // The crash this case is about, and the only window the ledger exists
      // for: `finishToolCall` landed and the state write that carries its
      // answer did not (a background kill, a fence, a pool error between the
      // two). Rewinding the column to the transcript the turn was claimed with
      // is exactly what a worker killed between them leaves behind.
      const rewound = await sql`
        update course.turns
           set state = ${sql.json({
             step: 0,
             messages: [{ role: 'user', content: [{ type: 'text', text: HER_MESSAGE }] }],
           } as never)}
         where id = ${turnId}
        returning id`
      expect(rewound).toHaveLength(1)

      await runTurn(workerDeps(sql, { agent }), turnId)

      const rows = await sql<{ call_id: string; status: string }[]>`
        select call_id, status from course.tool_calls where turn_id = ${turnId}`
      // ONE row, keyed on step and block index rather than on either toolu_ id,
      // and the supplier was called once. Keyed on the reply's own id there
      // would be two rows, two searches, and, in the window before
      // `finishToolCall`, a `pending` row under an id nothing will ever present
      // again: the ambiguous detection bypassed entirely by a call that arrives
      // under a different key.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.call_id).toBe('s0-b0')
      expect(rows[0]!.status).toBe('done')
      expect(executions).toBe(1)
    })
  })
})
