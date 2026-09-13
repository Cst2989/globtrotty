import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { capturePolicyFor, pgSink, redactCredentials, MAX_STORED } from '../src/repo/model-calls.js'
import { SEATS, type SeatName } from '../src/seats.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

/**
 * The sentinel below is a hand-written fixture and not anybody's key. It is the
 * shape `CREDENTIAL_PATTERNS` matches, spelled out so a pattern deleted in a
 * refactor is a red test rather than a quieter log.
 */
const FAKE_KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAA'

describe('redactCredentials', () => {
  it('takes out an api key, a bearer token, a basic header and a url password', () => {
    // One case per pattern in CREDENTIAL_PATTERNS. The patterns are deliberately
    // broad: over-redacting a trace costs a little debuggability,
    // under-redacting writes a live credential to a table module 7 keeps for
    // ninety days.
    for (const [secret, carrier] of [
      [FAKE_KEY, `key=${FAKE_KEY}`],
      ['Bearer abcdefgh12345678', 'authorization: Bearer abcdefgh12345678'],
      ['Basic dXNlcjpodW50ZXIy', 'authorization: Basic dXNlcjpodW50ZXIy'],
      ['hunter2', 'https://api.example:hunter2@supplier.example/search'],
      ['s3cr3tvalue1234', 'api_key: s3cr3tvalue1234'],
    ]) {
      const out = redactCredentials(carrier!)
      expect(out).not.toContain(secret!)
      expect(out).toContain('[REDACTED]')
    }
  })

  it('leaves ordinary text alone, which is what keeps it switched on', () => {
    // A redactor that ate a hotel description would be turned off, and the one
    // thing worse than an over-broad pattern here is no pattern at all.
    const ordinary = 'Beachfront apartment, Faro, 7 nights, sourceId hotel-0-4471, ref TP1234.'
    expect(redactCredentials(ordinary)).toBe(ordinary)
  })

  it('finds a credential nested inside a content block', () => {
    // The case the redact-then-reparse design exists for, and it rested on code
    // inspection with no test until it got one. A scan of the top-level object
    // would never look inside content[1].text.
    const response = { content: [
      { type: 'text', text: 'Here you go' },
      { type: 'text', text: `debug: ${FAKE_KEY}` },
    ] }
    const out = JSON.parse(redactCredentials(JSON.stringify(response))) as
      { content: unknown[] }
    expect(JSON.stringify(out)).not.toContain('sk-ant-api03-AAAA')
    expect(out.content).toHaveLength(2)
    // And it is still an object, not a string. sql.json on a string stores a
    // jsonb string scalar and every -> and ->> on it returns null forever.
    expect(typeof out).toBe('object')
  })

  it('takes out a password inside a connection string in any scheme', () => {
    // Learned outside the code: a malformed DATABASE_URL once missed a masking
    // regex and echoed a live password into a transcript.
    expect(redactCredentials('postgres://user:hunter2@db.example:5432/x'))
      .not.toContain('hunter2')
  })
})

describe('capturePolicyFor', () => {
  it('captures a driver and a front desk call in full', () => {
    // The calls anyone ever debugs. A truncated driver prompt is a debugging
    // session that ends at the truncation.
    for (const seat of ['driver', 'front_desk'] as SeatName[]) {
      expect(capturePolicyFor(seat, 200_000, 200_000)).toBe('full')
    }
  })

  it('has a policy for every seat, so a new seat cannot arrive without one', () => {
    // Iterated over SEATS rather than over a list in this file. A seat added in
    // module 6 with no thought given to its capture policy takes the truncating
    // branch by default, which is the safe direction, and this case is what
    // makes that a decision somebody saw rather than a fall-through.
    for (const name of Object.keys(SEATS) as SeatName[]) {
      expect(['full', 'truncated', 'sampled_out'])
        .toContain(capturePolicyFor(name, 100, 100))
    }
  })

  it('truncates a monitor call above the threshold, like every other cheap seat', () => {
    // The monitor reads a whole turn's events and model calls, so its prompt is
    // the largest of the cheap ones and it runs on every turn. It is exactly
    // the volume the threshold exists for.
    expect(capturePolicyFor('monitor', 9_000, 0)).toBe('truncated')
  })

  it('truncates a scout above eight kilobytes, in bytes and not code units', () => {
    // A fan-out is three rows per tool call and the volume is the cost. Sized in
    // UTF-8 bytes, because that is what the column costs: a CJK prompt is three
    // times its `.length` on disk.
    expect(capturePolicyFor('scout', 9_000, 0)).toBe('truncated')
    expect(capturePolicyFor('scout', 100, 100)).toBe('full')
  })
})

async function seededTurn(sql: postgres.Sql) {
  const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
  const conversationId = c!.id as string
  const [t] = await sql`
    insert into course.turns (conversation_id, user_id, idempotency_key)
    values (${conversationId}, ${USER}, ${randomUUID()}) returning id`
  return { conversationId, turnId: t!.id as string }
}

describeDb('what the row carries', () => {
  it('stores the response as an object, not as a json string scalar', async () => {
    await withTestDb(async (sql) => {
      // The failure the redact-then-reparse design exists to avoid, asserted
      // through SQL rather than through the object we just built: with
      // `sql.json(<a string>)` the row is there, the column is not null, and
      // `response->>'stop_reason'` is null forever.
      const { turnId, conversationId } = await seededTurn(sql)
      await pgSink(sql, { conversationId, turnId, userId: USER })({
        seat: 'driver', seatConfig: SEATS.driver, promptVersion: 'planning@1',
        modelRequested: SEATS.driver.model, modelReturned: SEATS.driver.model,
        usage: { input_tokens: 40, cache_creation_input_tokens: 0,
                 cache_read_input_tokens: 0, output_tokens: 20 },
        costMicros: 42n, latencyMs: 900, requestId: 'req_01',
        systemPrompt: `You are the planning desk. key=${FAKE_KEY}`,
        userPrompt: 'Portugal in September', thinkingMode: 'adaptive',
        response: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Let me look at Faro.' }] },
      })
      const [row] = await sql<{ stop_reason: string; policy: string; system_prompt: string
                               request_id: string; thinking_mode: string }[]>`
        select response->>'stop_reason' as stop_reason,
               capture_policy as policy, system_prompt, request_id, thinking_mode
          from course.model_calls where turn_id = ${turnId}`
      expect(row!.stop_reason).toBe('end_turn')
      expect(row!.policy).toBe('full')
      expect(row!.request_id).toBe('req_01')
      expect(row!.thinking_mode).toBe('adaptive')
      // And the credential that was in the prompt is not in the column.
      expect(row!.system_prompt).not.toContain('sk-ant-api03-AAAA')
      expect(row!.system_prompt).toContain('[REDACTED]')
    })
  })

  it('clips a truncated prompt at the stored limit, which nothing executed before', async () => {
    // `MAX_STORED` fires only on `policy === 'truncated'`, and the two cases
    // beside this one write a `full` row and a null row, so the clip was stated
    // in a docstring and run by nothing. A cheap seat with a prompt over the 8KB
    // threshold is the row the limit exists for: a scout fan-out is three rows
    // per tool call and the volume is the cost.
    await withTestDb(async (sql) => {
      const { turnId, conversationId } = await seededTurn(sql)
      const huge = 'a'.repeat(70_000)
      await pgSink(sql, { conversationId, turnId, userId: USER })({
        seat: 'scout', seatConfig: SEATS.scout, promptVersion: 'scout@1',
        modelRequested: SEATS.scout.model, modelReturned: SEATS.scout.model,
        usage: { input_tokens: 20_000, cache_creation_input_tokens: 0,
                 cache_read_input_tokens: 0, output_tokens: 50 },
        costMicros: 7n, latencyMs: 120,
        // No `capturePolicy` passed, so `pgSink` derives it: this is also the
        // case that proves the derivation happens rather than being trusted.
        systemPrompt: huge, userPrompt: 'Faro',
      })
      const [row] = await sql<{ policy: string; system_len: number; user_len: number }[]>`
        select capture_policy as policy,
               length(system_prompt) as system_len, length(user_prompt) as user_len
          from course.model_calls where turn_id = ${turnId}`
      expect(row!.policy).toBe('truncated')
      expect(row!.system_len).toBe(MAX_STORED)
      // The short one is untouched: the clip is a ceiling and not a fixed width.
      expect(row!.user_len).toBe('Faro'.length)
    })
  })

  it('leaves the capture columns null for a caller that captures nothing', async () => {
    await withTestDb(async (sql) => {
      // Every field is optional, because the other `pgSink` callers write none
      // of them. A row that said `capture_policy = 'full'` and carried no
      // prompt would describe a capture that never happened.
      const { turnId, conversationId } = await seededTurn(sql)
      await pgSink(sql, { conversationId, turnId, userId: USER })({
        seat: 'cheap', seatConfig: SEATS.cheap, promptVersion: 'classify@1',
        modelRequested: SEATS.cheap.model, modelReturned: SEATS.cheap.model,
        usage: { input_tokens: 10, cache_creation_input_tokens: 0,
                 cache_read_input_tokens: 0, output_tokens: 5 },
        costMicros: 1n, latencyMs: 30,
      })
      const [row] = await sql<{ policy: string | null; system_prompt: string | null
                               response: unknown }[]>`
        select capture_policy as policy, system_prompt, response
          from course.model_calls where turn_id = ${turnId}`
      expect(row!.policy).toBeNull()
      expect(row!.system_prompt).toBeNull()
      expect(row!.response).toBeNull()
    })
  })
})
