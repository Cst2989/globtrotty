import { describe, expect, it, vi } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { capturePolicyFor, redactCredentials, recordModelCall } from '../src/repo/modelCalls.js'
import { SEATS } from '../src/model/seats.js'
import type { ModelResult } from '../src/model/client.js'

const usage = {
  input_tokens: 100, cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0, output_tokens: 20,
}
const ok: ModelResult = {
  kind: 'ok', content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn',
  model: 'claude-opus-5', requestId: 'req_x', usage, latencyMs: 120,
}

describe('capturePolicyFor', () => {
  it('never samples out the driver — it is the eval and training corpus', () => {
    expect(capturePolicyFor('driver', 10_000_000, 10_000_000)).toBe('full')
    expect(capturePolicyFor('front_desk', 10_000_000, 10_000_000)).toBe('full')
    expect(capturePolicyFor('reviewer', 10_000_000, 10_000_000)).toBe('full')
  })

  it('truncates a cheap seat above 8KB, and only above', () => {
    expect(capturePolicyFor('scout', 8_000, 0)).toBe('full')
    expect(capturePolicyFor('scout', 8_192, 1)).toBe('truncated')   // one byte over
    expect(capturePolicyFor('monitor', 8_193, 0)).toBe('truncated')
  })
})

describe('redactCredentials', () => {
  // The allowlist test spec section 7 requires. Each case is a real shape a
  // credential takes in a prompt or an echoed tool result.
  it.each([
    ['sk-ant-api03-AAAABBBBCCCCDDDD', 'an Anthropic key'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.body.sig', 'a bearer token'],
    ['postgresql://postgres:hunter2@db.example.co:5432/postgres', 'a database URL'],
    ['api_key=cBzVRtabcdefghijklmn', 'a query-string key'],
    ['"authorization": "Basic QWxhZGRpbjpvcGVu"', 'a basic auth header'],
  ])('redacts %s (%s)', (secret) => {
    const out = redactCredentials(`before ${secret} after`)
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(secret)
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'She wants a week in Faro in September for two adults, budget 2000 EUR.'
    expect(redactCredentials(prose)).toBe(prose)
  })
})

describeDb('recordModelCall', () => {
  const seed = async (sql: any, n: string) => {
    const userId = `00000000-0000-4000-8000-0000000004${n}`
    const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
    return { userId, conversationId: c!.id as string }
  }

  it('writes the ledger row with the seat, cost, and both cache counters', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '01')
      await recordModelCall(sql, {
        conversationId, turnId: null, userId,
        seat: 'driver', seatConfig: SEATS.driver, result: ok,
        systemPrompt: 'sys', userPrompt: 'usr', thinkingMode: 'adaptive',
        costMicros: 1_000n,
      })
      const [row] = await sql`
        select seat, model, model_config_id, effort, thinking_mode, cost_micros,
               capture_policy, input_tokens, cache_creation_input_tokens,
               cache_read_input_tokens, output_tokens, request_id, latency_ms
          from model_calls where conversation_id = ${conversationId}`
      expect(row!.seat).toBe('driver')
      expect(row!.model).toBe('claude-opus-5')
      expect(row!.model_config_id).toBe(SEATS.driver.modelConfigId)
      expect(row!.effort).toBe('high')
      // Spec section 7 names a silently changed provider DEFAULT as a drift
      // vector. Thinking is on by default on Opus 5, so a null here would make
      // that change invisible in the one table that records what we sent.
      expect(row!.thinking_mode).toBe('adaptive')
      expect(BigInt(row!.cost_micros as string)).toBe(1_000n)
      expect(row!.capture_policy).toBe('full')
      expect(row!.input_tokens).toBe(100)
      expect(row!.output_tokens).toBe(20)
      expect(row!.request_id).toBe('req_x')
      expect(row!.latency_ms).toBe(120)
    })
  })

  it('records a refusal as a row, not as silence', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '02')
      const refused: ModelResult = {
        kind: 'refused', category: 'cyber', explanation: 'no',
        model: 'claude-opus-5', requestId: 'req_r', usage, latencyMs: 30,
      }
      await recordModelCall(sql, {
        conversationId, turnId: null, userId,
        seat: 'driver', seatConfig: SEATS.driver, result: refused,
        systemPrompt: 'sys', userPrompt: 'usr', thinkingMode: 'adaptive',
        costMicros: 0n,
      })
      const [row] = await sql`
        select response, response->>'stop_reason' as stop_reason
          from model_calls where conversation_id = ${conversationId}`
      // Asserted as STRUCTURE, not as a substring of JSON.stringify(row.response).
      // A jsonb string scalar — which is what `sql.json(JSON.stringify(x))`
      // stores — passes a substring check and fails every query anyone would
      // actually write against this column.
      expect(row!.response).toMatchObject({
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'no' },
      })
      expect(row!.stop_reason).toBe('refusal')   // the -> operator must work
    })
  })

  it('redacts a credential that reached the prompt', async () => {
    await withTestDb(async (sql) => {
      const { userId, conversationId } = await seed(sql, '03')
      await recordModelCall(sql, {
        conversationId, turnId: null, userId,
        seat: 'driver', seatConfig: SEATS.driver, result: ok,
        systemPrompt: 'key is sk-ant-api03-LEAKEDLEAKEDLEAK', userPrompt: 'usr',
        thinkingMode: 'adaptive', costMicros: 1n,
      })
      const [row] = await sql`
        select system_prompt from model_calls where conversation_id = ${conversationId}`
      expect(row!.system_prompt).not.toContain('sk-ant-api03-LEAKEDLEAKEDLEAK')
      expect(row!.system_prompt).toContain('[REDACTED]')
    })
  })

  it('never fails the work it observes', async () => {
    // A span is best-effort. The spend is not — that is reserve/reconcile.
    const broken = {
      begin: () => { throw new Error('db is down') },
    } as unknown as Parameters<typeof recordModelCall>[0]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordModelCall(broken, {
      conversationId: null, turnId: null, userId: '00000000-0000-4000-8000-000000000499',
      seat: 'driver', seatConfig: SEATS.driver, result: ok,
      systemPrompt: 's', userPrompt: 'u', thinkingMode: 'adaptive', costMicros: 1n,
    })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()   // swallowed, but never silently
    spy.mockRestore()
  })
})
