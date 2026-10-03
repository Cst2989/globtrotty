// Plan 5 Task 7. `makeChoose` returns the `(user, req, ctx)` handler
// `withUser` wraps — this file calls that inner handler directly with a
// fixed `SessionUser`, the same pattern test/web-api-messages.test.ts and
// test/web-api-proposals.test.ts already use. Imported from
// `web/chooseRoute.ts`, not from the route file itself: a Next Route
// Handler file may export only the recognised HTTP-method functions (see
// that module's own header comment).
import { expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { makeChoose, type ChooseRouteDeps } from '../web/chooseRoute.js'
import type { SessionUser } from '../web/session.js'
import { parseAction } from '../src/actions.js'
import { recordResults } from '../src/repo/toolResults.js'
import { MockSupplier } from '../src/supplier/mock.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import type { FlightSearch } from '../src/supplier/types.js'

const NOW = new Date('2026-09-13T12:00:00Z')
const flightParams: FlightSearch = {
  kind: 'flight', from: 'BCN', to: 'TYO', departureDate: '2026-11-19', returnDate: '2026-12-06',
  flexDays: 0, adults: 2, children: 0, infants: 0, cabinClass: 'Economy',
  currency: 'EUR', maxStops: null, allowSelfTransfer: false,
}

const USER: SessionUser = { id: '00000000-0000-4000-8000-00000000e001', email: 'a@b.com' }
const OTHER: SessionUser = { id: '00000000-0000-4000-8000-00000000e002', email: 'c@d.com' }

async function seed(sql: postgres.Sql, userId: string, n: string) {
  const [c] = await sql`insert into conversations (user_id, desk) values (${userId}, 'planning') returning id`
  const conversationId = c!.id as string
  const flights = new MockSupplier({ kind: 'flight', now: () => NOW })
  const fp = { ...flightParams, flexDays: Number(n) }
  const items = await flights.search(fp)
  await recordResults(sql, { conversationId, userId, turnId: null, params: fp, items })
  return { conversationId, sourceId: items[0]!.sourceId }
}

function req(body: unknown): Request {
  return new Request('http://x.test/api/conversations/x/choose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

describeDb('POST /api/conversations/[id]/choose', () => {
  it('a valid choice writes the action row and queues a turn', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '01')
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps: ChooseRouteDeps = { sql, invoke }
      const handler = makeChoose(deps)

      const res = await handler(USER, req({ kind: 'flight', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(invoke).toHaveBeenCalledTimes(1)

      const msgs = await sql`select role, content from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('action')
      expect(parseAction(msgs[0]!.content as string)).toEqual({ action: 'choose', kind: 'flight', sourceId: s.sourceId })

      const turns = await sql`select status from turns where conversation_id = ${s.conversationId}`
      expect(turns).toHaveLength(1)
      expect(turns[0]!.status).toBe('queued')
    })
  })

  it('a conversation belonging to another user is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, OTHER.id, '02')
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      const res = await handler(USER, req({ kind: 'flight', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('an unknown sourceId is 404, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '03')
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      const res = await handler(USER, req({ kind: 'flight', sourceId: 'MOCK-flight-nope' }), ctx(s.conversationId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const msgs = await sql`select id from messages where conversation_id = ${s.conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('a sourceId that exists but is the wrong kind is 404', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '04')
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      // s.sourceId is a FLIGHT id; claiming it as a hotel choice must not pass the corpus check.
      const res = await handler(USER, req({ kind: 'hotel', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  it('a non-uuid id is 404 before any query runs', async () => {
    await withTestDb(async (sql) => {
      const handler = makeChoose({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ kind: 'flight', sourceId: 'x' }), ctx('not-a-uuid'))
      expect(res.status).toBe(404)
    })
  })

  it('an invalid body is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '05')
      const handler = makeChoose({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ kind: 'bogus', sourceId: 'x' }), ctx(s.conversationId))
      expect(res.status).toBe(400)
    })
  })

  it('a malformed JSON body is 400', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '06')
      const handler = makeChoose({ sql, invoke: vi.fn() })
      const res = await handler(USER, req('not json'), ctx(s.conversationId))
      expect(res.status).toBe(400)
    })
  })

  it('a turn already in flight is 409, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '07')
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${s.conversationId}, ${USER.id}, 'in-flight', 'running')`
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      const res = await handler(USER, req({ kind: 'flight', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'busy' })
      expect(invoke).not.toHaveBeenCalled()
      const actionRows = await sql`select id from messages where conversation_id = ${s.conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })

  it('a conversation not at the planning desk is 409, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '08')
      await sql`update conversations set desk = 'front' where id = ${s.conversationId}`
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      const res = await handler(USER, req({ kind: 'flight', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'not_planning' })
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  it('the account spend ceiling is 429, and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const s = await seed(sql, USER.id, '09')
      await sql`update conversations set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()} where id = ${s.conversationId}`
      const invoke = vi.fn()
      const handler = makeChoose({ sql, invoke })

      const res = await handler(USER, req({ kind: 'flight', sourceId: s.sourceId }), ctx(s.conversationId))

      expect(res.status).toBe(429)
      expect(invoke).not.toHaveBeenCalled()
      const actionRows = await sql`select id from messages where conversation_id = ${s.conversationId} and role = 'action'`
      expect(actionRows).toHaveLength(0)
    })
  })
})
