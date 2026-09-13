import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { escalate } from '../src/tools/escalate.js'
import { LogNotifier, type Notifier } from '../src/notify.js'
import { MAX_ESCALATIONS_PER_DAY } from '../src/repo/escalations.js'

const NOW = new Date('2026-09-13T12:00:00Z')
async function seed(sql: postgres.Sql, n: string) {
  const userId = `00000000-0000-4000-8000-000000000e${n}`
  const [c] = await sql`insert into conversations (user_id) values (${userId}) returning id`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key, status) values (${c!.id}, ${userId}, ${'e' + n}, 'running') returning id`
  return { userId, conversationId: c!.id as string, turnId: t!.id as string }
}
const deps = (sql: postgres.Sql, notifier: Notifier = new LogNotifier(() => {})) => ({ sql, notifier, now: () => NOW.getTime() })

describeDb('escalate_to_human', () => {
  it('writes the row, marks the conversation escalated, notifies, and stamps notified_at', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '01')
      const notify = vi.fn().mockResolvedValue(undefined)
      const out = await escalate(deps(sql, { notify }), s, { reason: 'price_moved' })
      expect(out).toMatch(/escalated/i)
      const [e] = await sql`select reason, notified_at, turn_id from escalations where conversation_id = ${s.conversationId}`
      expect(e!.reason).toBe('price_moved'); expect(e!.notified_at).not.toBeNull(); expect(e!.turn_id).toBe(s.turnId)
      const [c] = await sql`select status from conversations where id = ${s.conversationId}`
      expect(c!.status).toBe('escalated')
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: 'price_moved', conversationId: s.conversationId }))
    })
  })
  it('keeps the row and the status when the notifier throws; notified_at stays null', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '02')
      const out = await escalate(deps(sql, { notify: vi.fn().mockRejectedValue(new Error('smtp down')) }), s, { reason: 'safety' })
      expect(out).toMatch(/escalated/i)
      const [e] = await sql`select notified_at from escalations where conversation_id = ${s.conversationId}`
      expect(e!.notified_at).toBeNull()
      const [c] = await sql`select status from conversations where id = ${s.conversationId}`
      expect(c!.status).toBe('escalated')
    })
  })
  it('refuses the fourth escalation in a UTC day, and allows it the next day', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '03')
      for (let i = 0; i < MAX_ESCALATIONS_PER_DAY; i++) {
        await sql`insert into escalations (conversation_id, user_id, reason, created_at) values (${s.conversationId}, ${s.userId}, 'user_request', ${new Date(NOW.getTime() - i * 60_000)})`
      }
      const notify = vi.fn()
      const out = await escalate(deps(sql, { notify }), s, { reason: 'user_request' })
      expect(out).toMatch(/limit/i); expect(notify).not.toHaveBeenCalled()
      expect(await sql`select 1 from escalations where conversation_id = ${s.conversationId}`).toHaveLength(MAX_ESCALATIONS_PER_DAY)
      const tomorrow = { ...deps(sql, { notify: vi.fn().mockResolvedValue(undefined) }), now: () => NOW.getTime() + 86_400_000 }
      expect(await escalate(tomorrow, s, { reason: 'user_request' })).toMatch(/escalated/i)
    })
  })
  it('refuses a proposal id from another conversation and records nothing', async () => {
    await withTestDb(async (sql) => {
      const a = await seed(sql, '04'); const b = await seed(sql, '05')
      const [p] = await sql`insert into proposals (conversation_id, user_id, itinerary, requirements_snapshot, total_minor, currency, gate_outcome)
        values (${a.conversationId}, ${a.userId}, '{"schemaVersion":1,"items":[]}', '{}', 0, 'EUR', 'approved') returning id`
      const out = await escalate(deps(sql), b, { reason: 'price_moved', proposalId: p!.id as string })
      expect(out).toMatch(/no proposal/i)
      expect(await sql`select 1 from escalations where conversation_id = ${b.conversationId}`).toHaveLength(0)
    })
  })
  it('the LogNotifier writes one line naming the reason and the conversation', async () => {
    const lines: string[] = []
    await new LogNotifier((l) => lines.push(l)).notify({ id: 'x', conversationId: 'c1', userId: 'u', turnId: null, proposalId: null, reason: 'safety', createdAt: NOW })
    expect(lines).toHaveLength(1); expect(lines[0]).toContain('safety'); expect(lines[0]).toContain('c1')
  })
  it('does not fail the turn when the notified_at stamp fails after a successful notify', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, '07')
      const notify = vi.fn().mockResolvedValue(undefined)
      // A stamp that cannot land: make the escalations row unreachable for the update
      // by wrapping sql so that `update escalations set notified_at` throws.
      const failingSql = new Proxy(sql, {
        apply(target, thisArg, args: unknown[]) {
          const text = String((args[0] as TemplateStringsArray).join('?'))
          if (text.includes('update escalations set notified_at')) throw new Error('stamp down')
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
        },
      }) as typeof sql
      const out = await escalate({ sql: failingSql, notifier: { notify }, now: () => NOW.getTime() }, s, { reason: 'safety' })
      expect(out).toMatch(/escalated/i)
      expect(notify).toHaveBeenCalledTimes(1)
      const [e] = await sql`select notified_at from escalations where conversation_id = ${s.conversationId}`
      expect(e!.notified_at).toBeNull()
    })
  })
})
