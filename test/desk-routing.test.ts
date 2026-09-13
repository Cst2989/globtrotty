import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import { classifyDesk } from '../src/classify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { costMicros } from '../src/pricing.js'
import { readDesk } from '../src/repo/conversations.js'
import { SEATS } from '../src/seats.js'
import { mockRunner } from '../src/tools.js'
import { runTurn } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { workerDeps } from './helpers/worker.js'
import { fakeClient, textMessage, toolUseMessage } from './model/fake.js'

const USER = randomUUID()

// Copied from test/driver.test.ts rather than exported from it: a test helper
// shared between two test files is a third file nobody names.
async function seededTurn(sql: postgres.Sql, text: string) {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${c!.id}, ${USER}, ${randomUUID()}) returning id`
  await sql`
    insert into course.messages (conversation_id, user_id, turn_id, role, content)
    values (${c!.id}, ${USER}, ${t!.id}, 'user', ${text})`
  return { conversationId: c!.id as string, turnId: t!.id as string }
}

describe('a reply the schema cannot read', () => {
  it('lands at the planning desk and is not called a label', async () => {
    // A hand-written reply, not a recorded one, and the lesson says so. Recording
    // a malformed structured output would mean asking the live API for a reply we
    // hope is broken, which is not a thing an API can be asked for. This one is
    // two fields long and its whole content is that it does not parse.
    const client = fakeClient([textMessage('The label is: faq (probably)')])
    const out = await classifyDesk('do I need a visa for Portugal', client)
    // The rule, in one assertion: any parse failure routes to planning, never
    // guesses, never drops. And `label: null` says the schema failed, which
    // `'other'` could not say, because `'other'` is an answer.
    expect(out.desk).toBe('planning')
    expect(out.label).toBeNull()
  })

  it('tells a parse failure apart from a message the model placed as "other"', async () => {
    const client = fakeClient([textMessage(JSON.stringify({ label: 'other' }))])
    const out = await classifyDesk('hello', client)
    expect(out.desk).toBe('planning')
    expect(out.label).toBe('other')
  })

  it('sends a factual question to the front desk, which has no doors', async () => {
    const client = fakeClient([textMessage(JSON.stringify({ label: 'faq' }))])
    expect((await classifyDesk('do I need a visa for Portugal', client)).desk).toBe('front')
  })
})

/**
 * Both cases carry an explicit twenty second deadline rather than vitest's
 * default five. They drive whole turns against a remote database and each step
 * is a handful of round trips; five seconds is close enough to the real figure
 * that a slow afternoon turns a green suite red, which is a worse failure than
 * a slow test.
 */
describeDb('the desk is decided once and remembered', () => {
  it('classifies on step 0 and reads the column on every step after it', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql, 'Portugal in September')
      const client = fakeClient([
        textMessage(JSON.stringify({ label: 'new_trip' })),
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Three stays near the beach.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      // Three replies used, not four: the classifier ran once, on step 0, and
      // steps 1 and 2 read course.conversations.desk instead of asking again.
      expect(client.calls).toBe(3)
      expect(await readDesk(sql, conversationId, USER)).toBe('planning')
    })
  }, 20_000)

  it('answers an FAQ at the front desk, on the cheap seat, with no tools published', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql, 'do I need a visa for Portugal')
      const client = fakeClient([
        textMessage(JSON.stringify({ label: 'faq' })),
        textMessage('Portugal is in the Schengen area, so it depends on your nationality.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      const rows = await sql<{ seat: string }[]>`
        select seat from course.model_calls where turn_id = ${turnId} order by seq`
      // Both calls on Haiku. At lesson-5-2 the second was Opus, and it is the
      // one that is five times the price.
      expect(rows.map((r) => r.seat)).toEqual(['front_desk', 'front_desk'])
    })
  }, 20_000)
})

describe('what an FAQ costs on the deployed path at lesson-5-2', () => {
  it('is priced at the driver seat, because the driver is the only desk', () => {
    // Roughly a thousand input tokens of prompt and transcript for a short
    // factual question, and a two hundred token answer.
    const usage = {
      input_tokens: 1_000, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 200,
    }
    const opus = costMicros(SEATS.driver.model, usage)
    const haiku = costMicros(SEATS.cheap.model, usage)
    expect(opus).toBe(10_000n)
    expect(haiku).toBe(2_000n)
    // Five times, on every question the front desk exists to answer, since
    // lesson 5.1 took it off the path.
    expect(opus / haiku).toBe(5n)
  })
})
