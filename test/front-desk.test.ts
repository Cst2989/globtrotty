import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeFrontDesk, parseFrontVerdict, FRONT_SCHEMA } from '../src/agents/frontDesk.js'
import { readDesk } from '../src/repo/conversations.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { ModelResult } from '../src/model/client.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const usage = { input_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }
const verdict = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn',
  model: 'claude-haiku-4-5-20251001', _request_id: 'req_f', usage })
const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null },
  model: 'claude-haiku-4-5-20251001', _request_id: 'req_f', usage }

async function seed(sql: postgres.Sql, n: string, text = 'a week in Portugal in September, two adults and a toddler') {
  const userId = `00000000-0000-4000-8000-000000000f${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id, desk`
  expect(c!.desk).toBe('front')
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'f' + n}, 'running') returning id`
  await sql`insert into messages (conversation_id, user_id, role, content) values (${c!.id}, ${userId}, 'user', ${text})`
  const ctx = { conversationId: c!.id as string, userId, turnId: t!.id as string,
    state: { step: 0, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] } }
  return ctx
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) =>
  ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('front desk', () => {
  it('new_trip: writes the title, moves the desk to planning, records the label, and continues', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '01')
      const create = vi.fn().mockResolvedValue(verdict({ label: 'new_trip', answer: null, title: 'Portugal, September, 2 adults + toddler' }))
      const step = await makeFrontDesk(deps(sql, create))(ctx)
      expect(step.kind).toBe('continue')
      if (step.kind !== 'continue') throw new Error('unreachable')
      expect(step.costMicros).toBe(0n)
      expect(step.recordedMicros).toBe(500n)          // 300*1 + 40*5
      const [c] = await sql`select desk, title, front_label from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ desk: 'planning', title: 'Portugal, September, 2 adults + toddler', front_label: 'new_trip' })
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.model).toBe('claude-haiku-4-5-20251001')
      expect((sent.output_config as Record<string, unknown>).format).toEqual({ type: 'json_schema', schema: FRONT_SCHEMA })
      expect(sent.tools).toBeUndefined()
      const [mc] = await sql`select seat, capture_policy, prompt_version from model_calls where turn_id = ${ctx.turnId}`
      expect(mc).toMatchObject({ seat: 'front_desk', capture_policy: 'full', prompt_version: 'front_desk@1' })
    })
  })
  it('faq: parks with the answer, stays at the front desk, records the label', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '02', 'do you take payment?')
      const step = await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(verdict({ label: 'faq', answer: 'No. We hand you booking links; you pay the supplier.', title: null }))))(ctx)
      expect(step.kind).toBe('park')
      if (step.kind !== 'park') throw new Error('unreachable')
      expect(step.message).toContain('booking links')
      expect(await readDesk(sql, ctx.conversationId, ctx.userId)).toBe('front')
      const [c] = await sql`select front_label, title from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ front_label: 'faq', title: null })
    })
  })
  it.each([
    ['unclear', verdict({ label: 'unclear', answer: null, title: null }), 'unclear'],
    ['refusal', refusal, 'fallback'],
    ['not JSON', verdict('hi'), 'fallback'],
    ['wrong shape', verdict({ ok: true }), 'fallback'],
    ['faq without an answer', verdict({ label: 'faq', answer: null, title: null }), 'fallback'],
    ['new_trip without a title', verdict({ label: 'new_trip', answer: null, title: null }), 'fallback'],
    ['max_tokens stop', { ...verdict({ label: 'new_trip' }), stop_reason: 'max_tokens' }, 'fallback'],
  ])('%s routes to planning without a title, label %s', async (_, resp, label) => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '03')
      const step = await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(resp)))(ctx)
      expect(step.kind).toBe('continue')
      const [c] = await sql`select desk, title, front_label from conversations where id = ${ctx.conversationId}`
      expect(c).toEqual({ desk: 'planning', title: null, front_label: label })
    })
  })
  it('masks control characters in the title and the answer', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '04')
      await makeFrontDesk(deps(sql, vi.fn().mockResolvedValue(verdict({ label: 'new_trip', answer: null, title: 'Lisbon\n## x' }))))(ctx)
      const [c] = await sql`select title from conversations where id = ${ctx.conversationId}`
      expect(c!.title).toBe('Lisbon?## x')
    })
  })
  it('fails the turn limit_reached when the reservation crosses a ceiling, refunding', async () => {
    await withTestDb(async (sql) => {
      const ctx = await seed(sql, '05')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${ctx.conversationId}`
      const create = vi.fn()
      const step = await makeFrontDesk(deps(sql, create))(ctx)
      expect(step.kind).toBe('fail'); if (step.kind !== 'fail') throw new Error('unreachable')
      expect(step.reason).toBe('limit_reached')
      expect(create).not.toHaveBeenCalled()
      const [c] = await sql`select spend_usd_micros, desk from conversations where id = ${ctx.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(DEFAULT_LIMITS.conversationCeilingMicros)
      expect(c!.desk).toBe('front')
    })
  })
  it('parseFrontVerdict never returns faq without an answer or new_trip without a title', () => {
    const ok = (v: unknown): ModelResult => ({ kind: 'ok', content: [{ type: 'text', text: JSON.stringify(v) }], stopReason: 'end_turn', model: 'm', requestId: null, usage, latencyMs: 1 })
    expect(parseFrontVerdict(ok({ label: 'faq', answer: '', title: null })).label).toBe('fallback')
    expect(parseFrontVerdict(ok({ label: 'new_trip', answer: null, title: '' })).label).toBe('fallback')
    expect(parseFrontVerdict(ok({ label: 'new_trip', answer: 'x', title: 'T' }))).toEqual({ label: 'new_trip', answer: null, title: 'T' })
  })
})
