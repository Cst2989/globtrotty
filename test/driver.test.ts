import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { mockRunner } from '../src/tools.js'
import { runTurn } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'
import { workerDeps } from './helpers/worker.js'

const USER = randomUUID()

async function seededTurn(sql: postgres.Sql, text = 'Portugal in September for 1500 euros') {
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

  it('keeps the provider tool_use id across the resume, so the ledger recognises the call', async () => {
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
      let stepBudget = 1
      await runTurn(
        workerDeps(sql, {
          agent, deadlineMs: () => (stepBudget-- > 0 ? Date.now() + 600_000 : Date.now() - 1),
        }),
        turnId,
      )
      await runTurn(workerDeps(sql, { agent }), turnId)
      const rows = await sql<{ call_id: string; status: string }[]>`
        select call_id, status from course.tool_calls where turn_id = ${turnId}`
      // One row, the provider's own id, done. toolLoop had to key its calls
      // positionally because a resumed turn asked the model again and got fresh
      // toolu_ ids back; a persisted transcript replays the SAME id, so the
      // provider's id is now the stable key and the positional scheme is not
      // needed on this path.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.call_id).toMatch(/^toolu_/)
      expect(rows[0]!.status).toBe('done')
    })
  })
})
