import { randomUUID } from 'node:crypto'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import type { ModelClient } from '../src/client.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { money } from '../src/money.js'
import { SYSTEM_CACHE_TTL } from '../src/model/cache.js'
import { costMicros, usageOf } from '../src/pricing.js'
import { rememberUserFact } from '../src/repo/memory.js'
import { applyRequirementsPatch } from '../src/repo/notebook.js'
import { SEATS } from '../src/seats.js'
import { ledgerRunner, mockRunner, type ToolRunner } from '../src/tools.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { apiError } from './helpers/errors.js'
import { fakeClient, labelMessage, textMessage, toolUseMessage } from './model/fake.js'
import { claimOf, workerDeps } from './helpers/worker.js'

const USER = randomUUID()

const HER_MESSAGE = 'Portugal in September for 1500 euros'

/**
 * A runner that stands in for the whole chain and counts how often it was
 * reached. Every case below that is about something the DRIVER answers by itself
 * asserts this counter stayed at zero: "the driver handled it" and "the driver
 * fell through to the chain" are otherwise indistinguishable from the outside.
 */
function countingRunner(): { run: ToolRunner; calls: () => number } {
  let calls = 0
  return {
    run: async () => {
      calls += 1
      return { content: 'the chain ran', isError: false }
    },
    calls: () => calls,
  }
}

/**
 * A client that keeps the request `buildRequest` assembled, which is the only
 * way to assert what actually went on the wire. `fakeClient` drops its argument.
 */
function recordingClient(replies: Message[]): ModelClient & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    async create(params: unknown) {
      sent.push(params as Record<string, unknown>)
      return replies[Math.min(sent.length - 1, replies.length - 1)]!
    },
  } as unknown as ModelClient & { sent: Record<string, unknown>[] }
}

/** Every text block of the LAST user turn of a request, joined. */
function lastUserText(request: Record<string, unknown>): string {
  const messages = request.messages as { role: string; content: { type: string; text?: string }[] }[]
  const last = [...messages].reverse().find((m) => m.role === 'user')!
  return last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

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
      // Two replies, because a routing call now comes first: `selectDesk`
      // classifies her message on step 0 and writes the answer to
      // course.conversations.desk (lesson 5.3).
      const client = fakeClient([
        labelMessage('new_trip'),
        textMessage('Three stays near the beach in Faro.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [turn] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.turns where id = ${turnId}`
      const calls = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from course.model_calls where turn_id = ${turnId} order by seq`
      // The routing call and the driver call, in that order, and the sum of the
      // two is what both counters have to read.
      expect(calls.map((c) => c.seat)).toEqual(['front_desk', 'driver'])
      const billed = calls.reduce((sum, c) => sum + BigInt(c.cost_micros), 0n)
      // The three have to agree exactly. This is the test that discriminates the
      // double charge: the driver reserves and reconciles its own spend, so a
      // step that also reported costMicros without alreadyRecorded would apply
      // the identical increment a second time and the conversation would read
      // twice the call.
      expect(BigInt(conv!.spend_usd_micros)).toBe(billed)
      expect(BigInt(turn!.spend_usd_micros)).toBe(billed)
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
        sql,
        client: fakeClient([labelMessage('new_trip'), refusal]),
        run: mockRunner(),
        limits: DEFAULT_LIMITS,
        now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      // SPEC section 8: a refusal fails the turn and does not consume quota, and
      // the refused call's own reservation is back exactly where it started.
      //
      // Not zero any more, and the difference is the point. A refusal refunds
      // its own reservation in full; it does not refund the routing call that
      // decided which desk would refuse. The figure is read back off the
      // front_desk row rather than recomputed here, so this asserts that the
      // conversation was charged exactly what was recorded and nothing else.
      const [routing] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls
         where turn_id = ${turnId} and seat = 'front_desk' order by seq`
      const routingCost = BigInt(routing!.cost_micros)
      expect(BigInt(conv!.spend_usd_micros)).toBe(routingCost)
      expect(routingCost).toBeGreaterThan(0n)
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
      //
      // No routing reply at the head of this list, unlike every other case here:
      // the outage reaches the FIRST call of the step, which from lesson 5.3 is
      // `selectDesk`'s classification call. So this now proves the routing
      // reservation is refunded too. Handing it a label first would have billed
      // one real Haiku call and left the zeroes below false.
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

  it("refunds the driver's OWN reservation when its call comes back 5xx, not just the router's", async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      // The other half of the case above, and the one that was untested. A valid
      // label first, so the routing call SUCCEEDS and is billed, and the outage
      // reaches `callModel` inside `makeDriver` instead. `fakeClient` repeats its
      // last entry, so all three attempts of the step get the same 503.
      const client = fakeClient([labelMessage('new_trip'), () => { throw apiError(503) }])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await expect(runTurn(workerDeps(sql, { agent }), turnId)).rejects.toThrow()
      // One routing call plus one driver call per attempt. The routing call is
      // not repeated, because the decision it wrote is read back by attempts 2
      // and 3 rather than bought again.
      expect(client.calls).toBe(4)
      const routing = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls
         where turn_id = ${turnId} and seat = 'front_desk' order by seq`
      expect(routing).toHaveLength(1)
      const routingCost = BigInt(routing[0]!.cost_micros)
      expect(routingCost).toBeGreaterThan(0n)

      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [day] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.daily_usage where user_id = ${USER}`
      // The routing call and NOTHING else on either ceiling. Three driver
      // reservations of roughly 400,000 micros were made and all three came back:
      // delete `if (isUnbilled(err)) await refund()` from `makeDriver` and this
      // reads over a million micros against one Haiku call that really happened.
      expect(BigInt(conv!.spend_usd_micros)).toBe(routingCost)
      expect(BigInt(day?.cost_micros ?? '0')).toBe(routingCost)

      const [turn] = await sql<{ fail_reason: string }[]>`
        select fail_reason from course.turns where id = ${turnId}`
      expect(turn!.fail_reason).toBe('provider_down')
    })
  })

  it('appends the assistant turn carrying the tool_use before the tool_result', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        labelMessage('new_trip'),
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
        labelMessage('new_trip'),
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
        labelMessage('new_trip'),
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
      // Two calls for that one step: the routing call, then the driver's.
      expect(client.calls).toBe(2)

      const [held] = await sql<{ status: string; state: { messages: unknown[] } }[]>`
        select status, state from course.turns where id = ${turnId}`
      expect(held!.status).toBe('queued')
      // Three lines already, held in the row: her message, what the model said,
      // and what the tool answered.
      expect(held!.state.messages).toHaveLength(3)

      await runTurn(workerDeps(sql, { agent }), turnId)
      // Three in total for the whole turn, not five. The second attempt picked
      // up the conversation rather than re-running it, which is the difference
      // between a resume and a restart, and it did not classify again either:
      // the resumed step is step 1, so `selectDesk` read
      // course.conversations.desk instead of asking the model.
      expect(client.calls).toBe(3)
    })
  })

  it('keys the call on its position, so a re-ask after a lost state write replays it', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql, HER_MESSAGE)
      const search = {
        city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1,
      }
      // ONE routing reply, for the whole turn. Rewinding the state below puts
      // the resumed turn back on step 0, which is the window `selectDesk` is
      // idempotent across: it finds this turn's own front_desk row and reuses
      // the decision instead of paying for a second one.
      const client = fakeClient([
        labelMessage('new_trip'),
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

      // And ONE routing row for the whole turn. The resumed attempt came back
      // on step 0, so a `selectDesk` that branched on the step counter alone
      // would classify her message a second time here, bill a second Haiku call
      // and rewrite course.conversations.desk for a decision already taken.
      const routing = await sql`
        select 1 from course.model_calls
         where turn_id = ${turnId} and seat = 'front_desk'`
      expect(routing).toHaveLength(1)
    })
  // Twenty seconds rather than vitest's default five. This case drives two whole
  // turns against a remote database, and lesson 5.3 put a classification call,
  // a reservation, a reconciliation, a model_calls row and a desk write in front
  // of step 0 of each of them. It went from just inside the default to just
  // outside it; the work is real and the deadline was the arbitrary half.
  }, 20_000)
})

/**
 * The three branches the driver answers WITHOUT the runner chain, none of which
 * had a test at lesson-5-2, and the one piece of the request the driver alone
 * assembles.
 *
 * They are worth pinning together because they share a failure mode: each one is
 * a `return` inside `makeDriver` that a later lesson can drop, reorder or fall
 * through, and the whole suite stays green while the behaviour changes. Lesson
 * 5.3 rewrites this function for desk selection.
 */
describeDb('what the driver answers by itself', () => {
  it('ends the turn on her question when the model asks one, and runs no tool', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      const questions = ['Which airport do you fly from?', 'How many nights?']
      // The routing reply first, then hers: `selectDesk` classifies her message
      // on step 0 before the driver's own call (lesson 5.3), so the first reply
      // queued here is the one it reads.
      const client = fakeClient([
        labelMessage('new_trip'),
        toolUseMessage('ask_user', { questions }),
      ])
      const chain = countingRunner()
      const agent = makeDriver({
        sql, client, run: chain.run, limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Terminal: TWO model calls and no third. The routing call, then the one
      // driver call that came back with her question, and nothing after it. The
      // chain was never reached either. `ask_user` is answered by her, so a
      // driver that let it fall through to `deps.run` would send it into the
      // runner chain, which has no wrapper for it, the model would be told its
      // question was an unknown tool, and the turn would take another step.
      expect(client.calls).toBe(2)
      expect(chain.calls()).toBe(0)

      const [msg] = await sql<{ content: string }[]>`
        select content from course.messages
         where turn_id = ${turnId} and role = 'agent'`
      expect(msg!.content).toBe(questions.join('\n\n'))
      const [turn] = await sql<{ status: string; fail_reason: string | null }[]>`
        select status, fail_reason from course.turns where id = ${turnId}`
      // A parked turn is `done` with no fail reason: nothing failed, she is
      // simply the next one to speak.
      expect(turn!.status).toBe('done')
      expect(turn!.fail_reason).toBe(null)
      const [conv] = await sql<{ status: string }[]>`
        select status from course.conversations where id = ${conversationId}`
      expect(conv!.status).toBe('awaiting_user')
      const calls = await sql`select 1 from course.tool_calls where turn_id = ${turnId}`
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses a malformed ask_user as a tool result rather than writing it to her', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        // The routing call's reply, ahead of the driver's own: `selectDesk`
        // classifies her message on step 0 (lesson 5.3) and takes the first
        // reply queued here. Step 1 reads the desk off the column and asks
        // nothing, so the two below are the driver's two steps.
        labelMessage('new_trip'),
        // What the registry's `AskUser` schema refuses: objects rather than
        // strings. `questions.join('\n\n')` on this array is the string
        // "[object Object]", and until this fix that string was the turn's reply
        // and went into `course.messages`, which is her thread.
        toolUseMessage('ask_user', { questions: [{ q: 'Which airport?' }, { q: 'How many nights?' }] }),
        textMessage('Which airport do you fly from?'),
      ])
      const chain = countingRunner()
      const agent = makeDriver({
        sql, client, run: chain.run, limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const messages = await sql<{ content: string }[]>`
        select content from course.messages where turn_id = ${turnId} and role = 'agent'`
      expect(messages).toHaveLength(1)
      expect(messages[0]!.content).toBe('Which airport do you fly from?')
      expect(messages[0]!.content).not.toContain('[object Object]')

      // The refusal went back as a tool result the model could act on, and it
      // did: its next reply is a question in prose. `validateToolCall` wrote the
      // sentence, which is the same door every other input goes through.
      const [row] = await sql<{ state: { messages: { content: { type: string; content?: string }[] }[] } }[]>`
        select state from course.turns where id = ${turnId}`
      const results = row!.state.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('Invalid input for "ask_user"')
      // Ephemeral by design, exactly like the supplier-budget refusal below: the
      // driver answers it without calling `deps.run`, so `ledgerRunner` never
      // sees it and no row is written for a call that never ran.
      expect(chain.calls()).toBe(0)
      const calls = await sql`select 1 from course.tool_calls where turn_id = ${turnId}`
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses a search once the turn has spent its supplier budget, and writes no row for it', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      // One search already recorded against this turn, which is the whole budget
      // under the limits below. `countSupplierCalls` reads `course.tool_calls`,
      // the ledger's own table, so this is the state a turn that has really
      // searched once is in.
      await sql`
        insert into course.tool_calls (turn_id, call_id, name, status)
        values (${turnId}, 's0-b0', 'search_hotels', 'done')`
      const client = fakeClient([
        // The routing reply `selectDesk` consumes on step 0 (lesson 5.3), then
        // the driver's own two steps. 'new_trip' keeps the turn on the planning
        // desk, which is the only desk that publishes `search_hotels` at all.
        labelMessage('new_trip'),
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Here is what I already have for Faro.'),
      ])
      const chain = countingRunner()
      const agent = makeDriver({
        sql,
        client,
        run: chain.run,
        limits: { ...DEFAULT_LIMITS, maxSupplierCallsPerTurn: 1 },
        now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // The supplier was not called, and the model was told why in a sentence it
      // can act on rather than by a failed turn: an unmet supplier budget is not
      // a fail reason and the model has steps left to propose from what it has.
      expect(chain.calls()).toBe(0)
      const [turn] = await sql<{ status: string; fail_reason: string | null }[]>`
        select status, fail_reason from course.turns where id = ${turnId}`
      expect(turn!.status).toBe('done')
      expect(turn!.fail_reason).toBe(null)

      const [row] = await sql<{ state: { messages: { content: { type: string; content?: string; is_error?: boolean }[] }[] } }[]>`
        select state from course.turns where id = ${turnId}`
      const results = row!.state.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toContain('No more searches will run')
      expect(results[0]!.is_error).toBe(true)

      // STILL one row, the seeded one. The refusal never reaches `deps.run`, so
      // `ledgerRunner`, the only writer of this table, never sees it. That is
      // deliberate: a refusal that wrote a row would count itself against
      // `countSupplierCalls` on the next step, so a refused search would consume
      // the quota it was refused for.
      const rows = await sql<{ call_id: string }[]>`
        select call_id from course.tool_calls where turn_id = ${turnId}`
      expect(rows.map((r) => r.call_id)).toEqual(['s0-b0'])
    })
  })

  it('refuses a fan-out the turn cannot afford, counting one search per city', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql)
      // Four searches already made, six allowed. `research_destination` reaches
      // the metered hotel supplier once per city, outside `supplierRunner` and
      // outside the ledger, so until this round it was a door through which a
      // turn could take three more searches while the budget reported four used
      // and the table showed four rows. Three cities do not fit in two.
      for (const i of [0, 1, 2, 3]) {
        await sql`
          insert into course.tool_calls (turn_id, call_id, name, status)
          values (${turnId}, ${`s0-b${i}`}, 'search_hotels', 'done')`
      }
      const client = fakeClient([
        labelMessage('new_trip'),
        toolUseMessage('research_destination',
          { cities: ['Faro', 'Lisbon', 'Porto'], question: 'Is the old town walkable?' }),
        textMessage('Here is what I already have.'),
      ])
      const chain = countingRunner()
      const agent = makeDriver({
        sql,
        client,
        run: chain.run,
        limits: { ...DEFAULT_LIMITS, maxSupplierCallsPerTurn: 6 },
        now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // No scout was sent, and no supplier was asked anything, because the
      // refusal never reaches the chain at all.
      expect(chain.calls()).toBe(0)
      const [turn] = await sql<{ status: string; fail_reason: string | null }[]>`
        select status, fail_reason from course.turns where id = ${turnId}`
      expect(turn!.status).toBe('done')
      expect(turn!.fail_reason).toBe(null)

      const [row] = await sql<{ state: { messages: { content: { type: string; content?: string; is_error?: boolean }[] }[] } }[]>`
        select state from course.turns where id = ${turnId}`
      const results = row!.state.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
      expect(results).toHaveLength(1)
      // The sentence says how many this call wanted and how many are left, so a
      // model asked for three with two left can ask for two.
      expect(results[0]!.content).toContain('needs 3 supplier searches')
      expect(results[0]!.content).toContain('2 of its 6 left')
      expect(results[0]!.content).toContain('No more searches will run')
      expect(results[0]!.is_error).toBe(true)

      // Still the four seeded rows: a refusal that wrote one would be counted by
      // `countSupplierCalls` on the next step, and a fan-out row counts three.
      const rows = await sql<{ call_id: string }[]>`
        select call_id from course.tool_calls where turn_id = ${turnId} order by call_id`
      expect(rows.map((r) => r.call_id)).toEqual(['s0-b0', 's0-b1', 's0-b2', 's0-b3'])
    })
  })

  it('sends the stored notebook as the request suffix, after the transcript and not in the prompt', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      await applyRequirementsPatch(sql, {
        conversationId, userId: USER, source: 'user', at: '2026-08-29T10:00:00Z',
        patch: { budget: money(150_000n, 'EUR'), destination: 'Portugal' },
      })
      // Two replies: the routing call's label, then the driver's answer.
      // 'new_trip' routes to the planning desk, which is the desk that carries a
      // notebook at all; the front desk is handed none on purpose.
      const client = recordingClient([
        labelMessage('new_trip'),
        textMessage('Three stays near the beach in Faro.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Two requests went out, the routing call's and the driver's, and it is
      // the driver's that carries the notebook. `selectDesk` sends her raw text
      // against a one-line label prompt and nothing else.
      expect(client.sent).toHaveLength(2)
      const request = client.sent[1]!
      // In the TRANSCRIPT, on the last user turn, which is where `withSuffix`
      // puts it (src/model/client.ts) and therefore after any cache breakpoint
      // lesson 5.6 places. In the system prompt it would invalidate the cached
      // prefix the moment she stated a fact.
      const suffix = lastUserText(request)
      expect(suffix).toContain('## The notebook, as recorded')
      expect(suffix).toContain('Portugal')
      expect(suffix).toContain('EUR')
      expect(suffix).toContain('(user)')
      // `JSON.stringify` and not `String`, which was what this line used until
      // lesson 5.6 made `system` an array of blocks: `String([{...}])` is
      // "[object Object]", so the assertion passed against every implementation
      // there is, including one that rendered the whole notebook into the system
      // prompt. It is the assertion that pins the load bearing half of the
      // arrangement, and it spent one commit pinning nothing.
      expect(JSON.stringify(request.system)).not.toContain('The notebook, as recorded')
      // And it really is the suffix rather than a second user turn: the
      // transcript is her one message, with the notebook appended to it.
      expect((request.messages as unknown[]).length).toBe(1)
    })
  })
})

/** A reply whose usage says the prefix was written, then a reply that says it was read. */
const cold = textMessage('Let me look at Faro.', {
  usage: { input_tokens: 40, output_tokens: 20,
           cache_creation_input_tokens: 3_000, cache_read_input_tokens: 0 },
} as never)
const warm = textMessage('Three stays near the beach.', {
  usage: { input_tokens: 40, output_tokens: 20,
           cache_creation_input_tokens: 0, cache_read_input_tokens: 3_000 },
} as never)

describeDb('the cache, on the row and in the prompt', () => {
  it('records the cache read on the row, not only on the invoice', async () => {
    await withTestDb(async (sql) => {
      // Asserted against the fixture's own usage rather than against a live call:
      // `fakeClient` returns cache_creation on the first reply and cache_read on
      // the second, which is what the API does when the prefix matched. What this
      // pins is that the ROW carries the read, so a cache that silently stopped
      // working is visible in course.model_calls rather than only in a bill
      // somebody reads at the end of the month.
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([
        labelMessage('new_trip'),
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        warm,
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      const rows = await sql<{ cache_read_input_tokens: number }[]>`
        select cache_read_input_tokens from course.model_calls
         where turn_id = ${turnId} and seat = 'driver' order by seq`
      expect(rows.at(-1)!.cache_read_input_tokens).toBe(3_000)
    })
  })

  it('prices a cache write at the TTL it actually sent', async () => {
    await withTestDb(async (sql) => {
      // The row and the wire agree, which is the property a shared constant buys
      // and which a locally chosen '1h' string would lose the day cacheableSystem
      // changed its mind.
      const { turnId } = await seededTurn(sql)
      const client = fakeClient([labelMessage('new_trip'), cold])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      const [row] = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls
         where turn_id = ${turnId} and seat = 'driver' order by seq`
      expect(BigInt(row!.cost_micros))
        .toBe(costMicros(SEATS.driver.model, usageOf(cold), SYSTEM_CACHE_TTL))
      // And it is NOT what the five minute rate would have charged, which is the
      // assertion that discriminates: a driver that passed '5m' would pass every
      // other test in this file.
      expect(BigInt(row!.cost_micros))
        .not.toBe(costMicros(SEATS.driver.model, usageOf(cold), '5m'))
    })
  })

  it('carries her memory into the prompt, in front of the notebook', async () => {
    await withTestDb(async (sql) => {
      // Memory first and the notebook second, so the thing that changes most
      // often is the LAST thing in the request. Both sit in the suffix, after
      // the rolling breakpoint, so neither can invalidate the cached prefix.
      const { conversationId, turnId } = await seededTurn(sql)
      await rememberUserFact(sql, {
        userId: USER, fact: 'Will not fly a red-eye while travelling with a toddler.',
        inferred: false, sourceTurn: null,
      })
      await applyRequirementsPatch(sql, {
        conversationId, userId: USER, at: '2026-08-29T10:00:00Z', source: 'user',
        patch: { destination: 'Portugal' },
      })
      const client = recordingClient([
        labelMessage('new_trip'),
        textMessage('Three stays near the beach in Faro.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)

      const suffix = lastUserText(client.sent[1]!)
      expect(suffix).toContain('Will not fly a red-eye')
      // Fenced, because a fact is a thing somebody wrote down and one of the
      // writers is a model that had just read a supplier's page.
      expect(suffix).toContain('trust="untrusted"')
      expect(suffix.indexOf('Will not fly a red-eye'))
        .toBeLessThan(suffix.indexOf('## The notebook, as recorded'))
      // And the memory is not in the stable prefix, which is the half that gets
      // cached and the half a new fact would otherwise throw away.
      expect(JSON.stringify(client.sent[1]!.system)).not.toContain('red-eye')
    })
  })
})
