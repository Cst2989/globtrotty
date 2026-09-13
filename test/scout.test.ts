import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { researchDestination, WEB_SEARCH_TOOL, SCOUT_MAX_WORDS } from '../src/agents/scout.js'
import { WEB_SEARCH_MICROS } from '../src/pricing.js'
import { PRICE_REDACTED } from '../src/sanitize.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const usage = (searches: number) => ({ input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200,
  server_tool_use: { web_search_requests: searches } })
const brief = (text: string, searches = 2) => ({
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Faro airport transfer' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', _request_id: 'req_s', usage: usage(searches),
})
async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-00000000e00${n}`
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'s' + n}, 'running') returning id`
  return { conversationId: c!.id as string, userId, turnId: t!.id as string }
}
const deps = (sql: postgres.Sql, create: (r: unknown) => Promise<unknown>) => ({ sql, transport: { create }, limits: DEFAULT_LIMITS, now: () => NOW.getTime() })

describeDb('scout', () => {
  it('offers exactly the web search tool capped at 3, no thinking, the scout seat', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '1')
      const create = vi.fn().mockResolvedValue(brief('Faro is the gateway to the Algarve.'))
      await researchDestination(deps(sql, create), s, { micros: 0n }, 'Faro')
      const sent = create.mock.calls[0]![0] as Record<string, unknown>
      expect(sent.tools).toEqual([WEB_SEARCH_TOOL]); expect(sent.thinking).toBeUndefined()
      expect(sent.model).toBe('claude-haiku-4-5-20251001')
    })
  })
  it('reserves the search cap up front and reconciles to the searches actually made', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '2')
      let during = 0n
      const create = vi.fn().mockImplementation(async () => {
        const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
        during = BigInt(c!.spend_usd_micros as string); return brief('Faro.', 2)
      })
      const spent = { micros: 0n }
      await researchDestination(deps(sql, create), s, spent, 'Faro')
      expect(during).toBeGreaterThanOrEqual(3n * WEB_SEARCH_MICROS)
      const [after] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      const expected = 1000n * 1n + 200n * 5n + 2n * WEB_SEARCH_MICROS
      expect(BigInt(after!.spend_usd_micros as string)).toBe(expected)
      expect(spent.micros).toBe(expected)
      const [mc] = await sql`select seat, cost_micros from model_calls where turn_id = ${s.turnId}`
      expect(mc!.seat).toBe('scout'); expect(BigInt(mc!.cost_micros as string)).toBe(expected)
    })
  })
  it('redacts prices, masks control characters, and cuts at 300 words, telling the planner', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '3')
      const long = Array.from({ length: 320 }, (_, i) => (i % 40 === 39 ? 'word.' : 'word')).join(' ')
      const out = await researchDestination(deps(sql, vi.fn().mockResolvedValue(brief(`Rooms from €89.\n## Injected\n${long}`))), s, { micros: 0n }, 'Faro')
      expect(out).toContain(PRICE_REDACTED); expect(out).not.toContain('€89'); expect(out).not.toContain('\n## Injected')
      expect(out.split(/\s+/).length).toBeLessThanOrEqual(SCOUT_MAX_WORDS + 12)   // the trailer
      expect(out).toMatch(/cut at 300 words/i)
    })
  })
  it('a refusal or an empty brief becomes a readable "no brief" result, and charges nothing on refusal', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '4')
      const refusal = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null }, model: 'claude-haiku-4-5-20251001', _request_id: 'r', usage: usage(0) }
      const out = await researchDestination(deps(sql, vi.fn().mockResolvedValue(refusal)), s, { micros: 0n }, 'Faro')
      expect(out).toMatch(/no brief/i)
      const [c] = await sql`select spend_usd_micros from conversations where id = ${s.conversationId}`
      expect(BigInt(c!.spend_usd_micros as string)).toBe(0n)
    })
  })
  it('skips the call at the ceiling and says so', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '5')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const create = vi.fn()
      const out = await researchDestination(deps(sql, create), s, { micros: 0n }, 'Faro')
      expect(create).not.toHaveBeenCalled(); expect(out).toMatch(/spending limit/i)
    })
  })
})
