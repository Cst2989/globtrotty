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
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        toolUseMessage('search_flights',
          { from: 'BER', to: 'FAO', departureDate: '2026-09-19', returnDate: '2026-09-26',
            adults: 2, children: 1 }),
        textMessage('A week in Faro, flights and a beachfront stay, inside 1500 euros.'),
      ])
      const agent = makeDriver({
        sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now,
      })

      // One step per invocation, so the turn is handed back twice, which is
      // three claims of the same row.
      const oneStep = () => {
        let budget = 1
        return workerDeps(sql, {
          agent, deadlineMs: () => (budget-- > 0 ? Date.now() + 600_000 : Date.now() - 1),
        })
      }
      await runTurn(oneStep(), turnId)
      await runTurn(oneStep(), turnId)
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Three calls for three steps. At lesson-4-6 the same shape cost eight,
      // because each attempt re-ran classify, extract and the searches.
      expect(client.calls).toBe(3)

      const [row] = await sql<{ status: string }[]>`
        select status from course.turns where id = ${turnId}`
      expect(row!.status).toBe('done')

      const calls = await sql<{ cost_micros: string }[]>`
        select cost_micros from course.model_calls where turn_id = ${turnId} order by seq`
      expect(calls).toHaveLength(3)
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
