import { TODAY } from '../src/conversation.js'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { mockRunner } from '../src/tools.js'
import { runTurn } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { fakeClient, labelMessage, textMessage, toolUseMessage } from './model/fake.js'
import { workerDeps } from './helpers/worker.js'

const USER = randomUUID()

async function seededTurn(sql: postgres.Sql) {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${c!.id}, ${USER}, ${randomUUID()}) returning id`
  await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content)
    values (${c!.id}, ${USER}, ${t!.id}, 'user', 'Portugal in September, 1500 euros, one toddler')`
  return { conversationId: c!.id as string, turnId: t!.id as string }
}

describeDb('a turn that survives a crash and a resume', () => {
  it('carries the conversation across three invocations and pays for each call once', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql)
      const client = fakeClient([
        // The routing reply first, because from lesson 5.3 the FIRST model call
        // of step 0 is `selectDesk`'s. Without it the classifier reads a
        // `tool_use` reply, which carries no text block, `JSON.parse('')`
        // throws, the turn is routed to planning on a parse failure and the
        // search below is silently eaten by the call that was meant to route.
        labelMessage('new_trip'),
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        toolUseMessage('search_flights',
          { from: 'BER', to: 'FAO', departureDate: '2026-09-19', returnDate: '2026-09-26',
            adults: 2, children: 1 }),
        textMessage('A week in Faro, flights and a beachfront stay, inside 1500 euros.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
        today: TODAY,
      })

      // One step per invocation, so the turn is handed back twice, which is
      // three claims of the same row. The third `runTurn` claims a turn that is
      // still queued: the second hand-back happens after the flight search, and
      // the answer below is the step it has left.
      const oneStep = () => {
        let budget = 1
        return workerDeps(sql, {
          agent, deadlineMs: () => (budget-- > 0 ? Date.now() + 600_000 : Date.now() - 1),
        })
      }
      await runTurn(oneStep(), turnId)
      await runTurn(oneStep(), turnId)
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Four calls for three steps: one routing call on step 0, then one driver
      // call per step. At lesson-4-6 the same shape cost eight, because each
      // attempt re-ran classify, extract and the searches.
      expect(client.calls).toBe(4)

      const [row] = await sql<{ status: string; state: { messages: { content: { type: string; name?: string }[] }[] } }[]>`
        select status, state from course.turns where id = ${turnId}`
      expect(row!.status).toBe('done')
      // Both searches really ran, in order. This is the assertion the counts
      // above cannot make: four calls and four rows are equally true of a
      // turn whose first reply was consumed by something else and whose first
      // search never happened.
      const asked = row!.state.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.name)
      expect(asked).toEqual(['search_hotels', 'search_flights'])

      const calls = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls where turn_id = ${turnId} order by seq`
      expect(calls).toHaveLength(4)
      const billed = calls.reduce((sum, c) => sum + BigInt(c.cost_micros), 0n)
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [turnRow] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.turns where id = ${turnId}`
      // Every call charged once, across two hand-backs, on both ledgers.
      expect(BigInt(conv!.spend_usd_micros)).toBe(billed)
      expect(BigInt(turnRow!.spend_usd_micros)).toBe(billed)
    })
  })
})
