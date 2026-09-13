import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { makeDriver } from '../src/agents/driver.js'
import { classifyDesk } from '../src/classify.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { costMicros } from '../src/pricing.js'
import { SEATS } from '../src/seats.js'
import { mockRunner } from '../src/tools.js'
import { runTurn } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { workerDeps } from './helpers/worker.js'
import { apiError } from './helpers/errors.js'
import { fakeClient, labelMessage, textMessage, toolUseMessage } from './model/fake.js'

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
    const client = fakeClient([labelMessage('other')])
    const out = await classifyDesk('hello', client)
    expect(out.desk).toBe('planning')
    expect(out.label).toBe('other')
  })

  it('sends a factual question to the front desk, which has no doors', async () => {
    const client = fakeClient([labelMessage('faq')])
    expect((await classifyDesk('do I need a visa for Portugal', client)).desk).toBe('front')
  })
})

describeDb('the desk is decided once and remembered', () => {
  it('classifies on step 0 and reuses that decision on every step after it', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql, 'Portugal in September')
      const client = fakeClient([
        labelMessage('new_trip'),
        toolUseMessage('search_hotels',
          { city: 'Faro', checkIn: '2026-09-19', checkOut: '2026-09-26', adults: 2, children: 1 }),
        textMessage('Three stays near the beach.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      // Three replies used, not four: the classifier ran once, on step 0, and
      // steps 1 and 2 reused the decision instead of asking again.
      expect(client.calls).toBe(3)
      // The column itself, read here rather than through a helper, because what
      // this case is about is the value that landed in it.
      const [conv] = await sql<{ desk: string }[]>`
        select desk from course.conversations where id = ${conversationId}`
      expect(conv!.desk).toBe('planning')
    })
  })

  it('classifies once for a turn whose step is retried, and bills that call once', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql, 'Portugal in September')
      // A 503 on the DRIVER's call, after the routing call has already answered.
      // `withRetry` (src/retry.ts) wraps the whole agent step, so attempt 2
      // starts at step 0 again, which is the window `selectDesk` has to be
      // idempotent across: the column alone cannot tell "never decided" from
      // "decided planning", so the decision is read back from the turn's own
      // front_desk row.
      const client = fakeClient([
        labelMessage('new_trip'),
        () => { throw apiError(503) },
        textMessage('Three stays near the beach.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Three calls, not four: the routing call, the attempt that failed, and
      // the attempt that answered. A fourth would be attempt 2 classifying her
      // message again, which bills a second Haiku call and rewrites the column
      // for a decision that was already made.
      expect(client.calls).toBe(3)
      const rows = await sql<{ seat: string; cost_micros: string }[]>`
        select seat, cost_micros from course.model_calls where turn_id = ${turnId} order by seq`
      expect(rows.map((r) => r.seat)).toEqual(['front_desk', 'driver'])

      // And the money adds up on both ledgers. The failed attempt's reservation
      // came back in full (a 503 carries no usage), so what is left on each
      // counter is exactly the two calls that were recorded.
      const billed = rows.reduce((sum, r) => sum + BigInt(r.cost_micros), 0n)
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      const [turn] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.turns where id = ${turnId}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(billed)
      expect(BigInt(turn!.spend_usd_micros)).toBe(billed)
    })
  })

  it('stops before the routing call when its own reservation crosses the ceiling', async () => {
    await withTestDb(async (sql) => {
      const { conversationId, turnId } = await seededTurn(sql, 'Portugal in September')
      // A conversation one micro under its cap: `decideNext`'s check at the top
      // of `loop()` (src/worker.ts) passes, because nothing has been spent yet,
      // and the routing reservation is what crosses it.
      const client = fakeClient([labelMessage('new_trip'), textMessage('Three stays.')])
      const agent = makeDriver({
        sql, client, run: mockRunner(),
        limits: { ...DEFAULT_LIMITS, conversationCeilingMicros: 1n },
        now: Date.now,
      })
      await runTurn(workerDeps(sql, { agent }), turnId)

      // Not one call. The routing call reserves before it dispatches like every
      // other call, and it reads the counters that reserve returned: a capped
      // conversation that still buys one Haiku call per turn, and up to three
      // under `withRetry`, is the hole this closes.
      expect(client.calls).toBe(0)
      const [turn] = await sql<{ fail_reason: string }[]>`
        select fail_reason from course.turns where id = ${turnId}`
      expect(turn!.fail_reason).toBe('limit_reached')
      // The reservation that fired the ceiling is back where it started: a call
      // that never went out is not a call she pays for.
      const [conv] = await sql<{ spend_usd_micros: string }[]>`
        select spend_usd_micros from course.conversations where id = ${conversationId}`
      expect(BigInt(conv!.spend_usd_micros)).toBe(0n)
      const rows = await sql`select 1 from course.model_calls where turn_id = ${turnId}`
      expect(rows).toHaveLength(0)
    })
  })

  it('answers an FAQ at the front desk, on the cheap seat, with no tools published', async () => {
    await withTestDb(async (sql) => {
      const { turnId } = await seededTurn(sql, 'do I need a visa for Portugal')
      const client = fakeClient([
        labelMessage('faq'),
        textMessage('Portugal is in the Schengen area, so it depends on your nationality.'),
      ])
      const agent = makeDriver({ sql, client, run: mockRunner(), limits: DEFAULT_LIMITS, now: Date.now })
      await runTurn(workerDeps(sql, { agent }), turnId)
      const rows = await sql<{ seat: string }[]>`
        select seat from course.model_calls where turn_id = ${turnId} order by seq`
      // Both calls on Haiku. At lesson-5-2 the second was Opus, and it is the
      // one that is five times the price. The other half of the title, that the
      // request published no tools at all, is asserted over `buildRequest` in
      // test/request-shape.test.ts, which needs no database to ask it.
      expect(rows.map((r) => r.seat)).toEqual(['front_desk', 'front_desk'])
    })
  })
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
