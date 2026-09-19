// Plan 4a, Task 7. `makePost` returns the `(user, req, ctx)` handler that
// `withUser` wraps — this file calls that inner handler directly with a
// fixed `SessionUser`, so there is no need to mock `web/session.ts` here.
// `withUser`'s own 401 contract already has full coverage in
// test/web-session.test.ts; this file is about `submitMessage` wiring, body
// validation, and the status-code mapping.
//
// Imported from `web/messagesRoute.ts`, not from the route file itself:
// `app/api/conversations/[id]/messages/route.ts` re-exports only `POST` —
// see that module's own header comment for why `makePost` can't live there.
import { describe, expect, it, vi } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'
import { makePost, type MessagesRouteDeps } from '../web/messagesRoute.js'
import type { SessionUser } from '../web/session.js'

const USER: SessionUser = { id: '11111111-1111-1111-1111-111111111111', email: 'a@b.com' }
const OTHER = '22222222-2222-2222-2222-222222222222'

function req(body: unknown): Request {
  return new Request('http://x.test/api/conversations/new/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

type PostBody = { conversationId: string; turnId: string | null; status: string }

describeDb('POST /api/conversations/[id]/messages', () => {
  it('id=new creates a conversation via submitMessage and returns 200 queued', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps: MessagesRouteDeps = { sql, invoke }
      const handler = makePost(deps)

      const res = await handler(
        USER, req({ text: 'a week in Lisbon', idempotencyKey: 'idem-key-1' }), ctx('new'),
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as PostBody
      expect(body.status).toBe('queued')
      expect(body.conversationId).toBeTruthy()
      expect(body.turnId).toBeTruthy()
      expect(invoke).toHaveBeenCalledWith(body.turnId)

      const msgs = await sql`select user_id, content, role from messages where conversation_id = ${body.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.user_id).toBe(USER.id)
      expect(msgs[0]!.content).toBe('a week in Lisbon')
      expect(msgs[0]!.role).toBe('user')
    })
  })

  // Break: making the route read `user_id` off the body (instead of only
  // ever using the session user) would let this pass with a 200 and a row
  // written under OTHER's id. `z.strictObject` rejects the extra key
  // outright — a 400, never a silently-dropped field.
  it('a user_id in the body is rejected (400), not silently ignored or honored', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makePost({ sql, invoke })
      const before = await sql`select count(*)::int as n from messages`

      const res = await handler(
        USER, req({ text: 'hi', idempotencyKey: 'idem-key-2', user_id: OTHER }), ctx('new'),
      )

      expect(res.status).toBe(400)
      expect(invoke).not.toHaveBeenCalled()
      const after = await sql`select count(*)::int as n from messages`
      expect(after[0]!.n).toBe(before[0]!.n)
    })
  })

  it('rejects a body with no idempotencyKey', async () => {
    await withTestDb(async (sql) => {
      const handler = makePost({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ text: 'hi' }), ctx('new'))
      expect(res.status).toBe(400)
    })
  })

  it('rejects empty text', async () => {
    await withTestDb(async (sql) => {
      const handler = makePost({ sql, invoke: vi.fn() })
      const res = await handler(USER, req({ text: '', idempotencyKey: 'idem-key-3' }), ctx('new'))
      expect(res.status).toBe(400)
    })
  })

  it('rejects text over 4000 characters', async () => {
    await withTestDb(async (sql) => {
      const handler = makePost({ sql, invoke: vi.fn() })
      const res = await handler(
        USER, req({ text: 'x'.repeat(4001), idempotencyKey: 'idem-key-4' }), ctx('new'),
      )
      expect(res.status).toBe(400)
    })
  })

  it('rejects malformed JSON', async () => {
    await withTestDb(async (sql) => {
      const handler = makePost({ sql, invoke: vi.fn() })
      const res = await handler(USER, req('not json'), ctx('new'))
      expect(res.status).toBe(400)
    })
  })

  it('a repeat idempotency key on the same conversation returns 200 duplicate', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makePost({ sql, invoke })

      const first = await handler(USER, req({ text: 'hi', idempotencyKey: 'same-key' }), ctx('new'))
      const firstBody = (await first.json()) as PostBody

      const second = await handler(
        USER, req({ text: 'hi again', idempotencyKey: 'same-key' }), ctx(firstBody.conversationId),
      )
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as PostBody
      expect(secondBody.status).toBe('duplicate')
      expect(secondBody.turnId).toBe(firstBody.turnId)
    })
  })

  it('a second message while a turn is in flight returns 409 busy', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const handler = makePost({ sql, invoke })

      const first = await handler(USER, req({ text: 'one', idempotencyKey: 'busy-key-1' }), ctx('new'))
      const firstBody = (await first.json()) as PostBody

      const second = await handler(
        USER, req({ text: 'two', idempotencyKey: 'busy-key-2' }), ctx(firstBody.conversationId),
      )
      expect(second.status).toBe(409)
      const secondBody = (await second.json()) as PostBody
      expect(secondBody.status).toBe('busy')
    })
  })

  // Fix round 1 (Important). Break: comment out the ownership `select` in
  // web/messagesRoute.ts and this test 500s instead of 404ing — submitMessage
  // runs on the owner connection (bypasses RLS) and has no authorisation
  // check of its own; see that module's doc comment.
  it('a conversation id belonging to someone else returns 404 and writes nothing', async () => {
    await withTestDb(async (sql) => {
      const [row] = await sql`insert into conversations (user_id) values (${OTHER}) returning id`
      const conversationId = row!.id as string
      const invoke = vi.fn()
      const handler = makePost({ sql, invoke })

      const res = await handler(
        USER, req({ text: 'hi', idempotencyKey: 'ownership-key-1' }), ctx(conversationId),
      )

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(0)
    })
  })

  it('a non-uuid conversation id returns 404 instead of reaching submitMessage', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn()
      const handler = makePost({ sql, invoke })

      const res = await handler(
        USER, req({ text: 'hi', idempotencyKey: 'ownership-key-2' }), ctx('not-a-uuid'),
      )

      expect(res.status).toBe(404)
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  it('a capped daily ceiling returns 429 limit_reached', async () => {
    await withTestDb(async (sql) => {
      const { DEFAULT_LIMITS } = await import('../src/limits.js')
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER.id}, (now() at time zone 'utc')::date, ${DEFAULT_LIMITS.dailyCeilingMicros.toString()})`
      const invoke = vi.fn()
      const handler = makePost({ sql, invoke })

      const res = await handler(USER, req({ text: 'hi', idempotencyKey: 'limit-key-1' }), ctx('new'))

      expect(res.status).toBe(429)
      const body = (await res.json()) as PostBody
      expect(body.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
