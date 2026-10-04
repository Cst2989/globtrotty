// Pass 3, section 1d. `makeRefresh` returns the `(user, req, ctx)` handler `withUser` wraps —
// this file calls that inner handler directly with a fixed `SessionUser`, the same pattern
// test/web-api-choose.test.ts uses. Imported from `web/refreshRoute.ts`, not from the route file
// itself: a Next Route Handler file may export only the recognised HTTP-method functions.
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeRefresh, type RefreshRouteDeps } from '../web/refreshRoute.js'
import type { SessionUser } from '../web/session.js'
import { parseAction } from '../src/actions.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER: SessionUser = { id: '00000000-0000-4000-8000-00000000f001', email: 'a@b.com' }
const OTHER: SessionUser = { id: '00000000-0000-4000-8000-00000000f002', email: 'c@d.com' }

async function seed(sql: postgres.Sql, userId: string): Promise<string> {
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  return c!.id as string
}

function req(body: unknown): Request {
  return new Request('http://x.test/api/conversations/x/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

describeDb('POST /api/conversations/[id]/refresh', () => {
  it('writes the refresh action in the ACTION vocabulary and queues a turn', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps: RefreshRouteDeps = { sql, invoke }

      const res = await makeRefresh(deps)(USER, req({ kind: 'flights' }), ctx(conversationId))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(invoke).toHaveBeenCalledTimes(1)

      const msgs = await sql`select role, content from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('action')
      // 'flights' on the wire, 'flight' in the action — see `ACTION_KIND`.
      expect(parseAction(msgs[0]!.content as string)).toEqual({ action: 'refresh', kind: 'flight' })

      const turns = await sql`select status from turns where conversation_id = ${conversationId}`
      expect(turns).toHaveLength(1)
      expect(turns[0]!.status).toBe('queued')
    })
  })

  it('maps hotels to the hotel action kind', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      const invoke = vi.fn().mockResolvedValue(undefined)
      const res = await makeRefresh({ sql, invoke })(USER, req({ kind: 'hotels' }), ctx(conversationId))
      expect(res.status).toBe(200)
      const msgs = await sql`select content from messages where conversation_id = ${conversationId} and role = 'action'`
      expect(parseAction(msgs[0]!.content as string)).toEqual({ action: 'refresh', kind: 'hotel' })
    })
  })

  it('a conversation belonging to another user is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, OTHER.id)
      const invoke = vi.fn()

      const res = await makeRefresh({ sql, invoke })(USER, req({ kind: 'flights' }), ctx(conversationId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('a non-uuid id is 404 before any query runs', async () => {
    await withTestDb(async (sql) => {
      const res = await makeRefresh({ sql, invoke: vi.fn() })(USER, req({ kind: 'flights' }), ctx('not-a-uuid'))
      expect(res.status).toBe(404)
    })
  })

  it('an invalid or malformed body is 400', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      const handler = makeRefresh({ sql, invoke: vi.fn() })
      // The ACTION vocabulary is not this route's: the body speaks of rows.
      expect((await handler(USER, req({ kind: 'flight' }), ctx(conversationId))).status).toBe(400)
      expect((await handler(USER, req({ kind: 'flights', sourceId: 'x' }), ctx(conversationId))).status).toBe(400)
      expect((await handler(USER, req('not json'), ctx(conversationId))).status).toBe(400)
    })
  })

  it('a turn already in flight is 409, and writes no action row', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${conversationId}, ${USER.id}, 'in-flight', 'running')`
      const invoke = vi.fn()

      const res = await makeRefresh({ sql, invoke })(USER, req({ kind: 'flights' }), ctx(conversationId))

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'busy' })
      expect(invoke).not.toHaveBeenCalled()
      const actionRows = await sql`select id from messages where conversation_id = ${conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })

  it('a conversation not at the planning desk is 409, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      await sql`update conversations set desk = 'front' where id = ${conversationId}`
      const invoke = vi.fn()

      const res = await makeRefresh({ sql, invoke })(USER, req({ kind: 'flights' }), ctx(conversationId))

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'not_planning' })
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  it('the spend ceiling is 429, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await seed(sql, USER.id)
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()}
                 where id = ${conversationId}`
      const invoke = vi.fn()

      const res = await makeRefresh({ sql, invoke })(USER, req({ kind: 'flights' }), ctx(conversationId))

      expect(res.status).toBe(429)
      expect(invoke).not.toHaveBeenCalled()
      const actionRows = await sql`select id from messages where conversation_id = ${conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })
})
