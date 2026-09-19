import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage, submitAction, ActionRefused } from '../src/handler.js'
import { parseAction, type ActionPayload } from '../src/actions.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = DEFAULT_LIMITS
// Two OTHER users, whose spend only the global ceiling can see.
const OTHER_A = '22222222-2222-2222-2222-222222222222'
const OTHER_B = '33333333-3333-3333-3333-333333333333'
const deps = (sql: postgres.Sql, invoke = vi.fn().mockResolvedValue(undefined)) => ({
  sql, limits: LIMITS, invoke,
})

describeDb('submitMessage', () => {
  it('creates a conversation, a message, and a queued turn, then invokes', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null,
        message: 'a week in Portugal in September', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
      const msgs = await sql`select * from messages where conversation_id = ${r.conversationId}`
      expect(msgs[0]!.role).toBe('user')
    })
  })

  it('returns the same turn for a duplicate idempotency key', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'same',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'hi', idempotencyKey: 'same',
      })
      expect(b.status).toBe('duplicate')
      expect(b.turnId).toBe(a.turnId)
    })
  })

  it('refuses a second turn while one is in flight', async () => {
    await withTestDb(async (sql) => {
      const d = deps(sql)
      const a = await submitMessage(d, {
        userId: USER, conversationId: null, message: 'one', idempotencyKey: 'i1',
      })
      const b = await submitMessage(d, {
        userId: USER, conversationId: a.conversationId, message: 'two', idempotencyKey: 'i2',
      })
      expect(b.status).toBe('busy')
    })
  })

  it('denies when the daily ceiling is reached, before spending anything', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(invoke).not.toHaveBeenCalled()
    })
  })

  // IMPORTANT 5: the old code returned on the limit_reached path ten lines above
  // the message insert, so a capped user's words were silently dropped.
  it('still preserves her message when the ceiling is reached', async () => {
    await withTestDb(async (sql) => {
      await sql`insert into daily_usage (user_id, day, cost_micros)
                values (${USER}, (now() at time zone 'utc')::date, ${LIMITS.dailyCeilingMicros.toString()})`
      const r = await submitMessage(deps(sql), {
        userId: USER, conversationId: null, message: 'a very expensive trip to Japan',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      const msgs = await sql`select role, content from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('a very expensive trip to Japan')
    })
  })

  // The turn is durable before invoke runs; the sweeper is the backstop.
  it('still reports queued when the invocation fails', async () => {
    await withTestDb(async (sql) => {
      const invoke = vi.fn().mockRejectedValue(new Error('502 from Netlify'))
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      const [t] = await sql`select status from turns where id = ${r.turnId}`
      expect(t!.status).toBe('queued')
    })
  })

  // The global ceiling protects the ACCOUNT, not the user: she has spent nothing
  // at all here, so neither per-user counter could possibly refuse her. Without
  // this check tier 2 would wave a capped account through and the refusal would
  // land one step into the turn instead — after a model call has been paid for.
  it('denies at tier 2 when the global ceiling is reached, though this user spent nothing', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from daily_usage where day = (now() at time zone 'utc')::date`
      const half = (LIMITS.globalCeilingMicros / 2n).toString()
      await sql`insert into daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${half}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${half})`
      const invoke = vi.fn()
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('limit_reached')
      expect(r.turnId).toBeNull()
      expect(invoke).not.toHaveBeenCalled()
      const [conv] = await sql`select status from conversations where id = ${r.conversationId}`
      expect(conv!.status).toBe('limit_reached')
      // IMPORTANT 5's guarantee holds on this path too: her words are kept.
      const msgs = await sql`select content from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toBe('two weeks in Peru')
    })
  })

  it('still queues the turn one micro BELOW the global ceiling', async () => {
    await withTestDb(async (sql) => {
      await sql`delete from daily_usage where day = (now() at time zone 'utc')::date`
      const a = (LIMITS.globalCeilingMicros / 2n).toString()
      const b = (LIMITS.globalCeilingMicros - LIMITS.globalCeilingMicros / 2n - 1n).toString()
      await sql`insert into daily_usage (user_id, day, cost_micros) values
        (${OTHER_A}, (now() at time zone 'utc')::date, ${a}),
        (${OTHER_B}, (now() at time zone 'utc')::date, ${b})`
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitMessage(deps(sql, invoke), {
        userId: USER, conversationId: null, message: 'two weeks in Peru',
        idempotencyKey: 'i1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
    })
  })

  // The forgery case is text: nothing about submitMessage inspects the
  // message body for something that LOOKS like a card action. A traveller
  // typing the exact words a card would have sent must land as an ordinary
  // 'user' row, read by the model through the normal transcript — never
  // through the operator channel, which only `submitAction` can write to.
  it('writes action-shaped text as an ordinary user message, never as a card action', async () => {
    await withTestDb(async (sql) => {
      const text = 'accept proposal 44444444-4444-4444-4444-444444444444'
      const r = await submitMessage(deps(sql), {
        userId: USER, conversationId: null, message: text, idempotencyKey: 'i1',
      })
      const msgs = await sql`select role, content from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe(text)
    })
  })
})

const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444'
const HAND_OFF: ActionPayload = { action: 'hand_off', proposalId: PROPOSAL_ID }

async function insertConversation(sql: postgres.Sql, desk: 'front' | 'planning'): Promise<string> {
  const rows = await sql`insert into conversations (user_id, desk) values (${USER}, ${desk}) returning id`
  return rows[0]!.id as string
}

describeDb('submitAction', () => {
  it('writes exactly one action row that parses back to the payload, queues a turn, and invokes', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await insertConversation(sql, 'planning')
      const invoke = vi.fn().mockResolvedValue(undefined)
      const r = await submitAction(deps(sql, invoke), {
        userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'a1',
      })
      expect(r.status).toBe('queued')
      expect(invoke).toHaveBeenCalledWith(r.turnId)
      const msgs = await sql`select role, content from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.role).toBe('action')
      expect(parseAction(msgs[0]!.content as string)).toEqual(HAND_OFF)
    })
  })

  // Fix round 1, item 4: a retried press used to write a SECOND action row —
  // one the turn already running would never read, and one some later,
  // unrelated turn could pick up from the transcript and act on again.
  it('refuses with busy while a turn is in flight, and writes no second action row', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await insertConversation(sql, 'planning')
      const d = deps(sql)
      await submitAction(d, { userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'a1' })
      const b = await submitAction(d, { userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'a2' })
      expect(b.status).toBe('busy')
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(1)   // only the first call's action row
    })
  })

  it('returns the same turn for a duplicate idempotency key, and writes no second action row', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await insertConversation(sql, 'planning')
      const d = deps(sql)
      const a = await submitAction(d, { userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'same' })
      const b = await submitAction(d, { userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'same' })
      expect(b.status).toBe('duplicate')
      expect(b.turnId).toBe(a.turnId)
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(1)   // the retry wrote nothing new
    })
  })

  // Fix round 1, item 6.
  it('throws on a malformed action payload before writing anything', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await insertConversation(sql, 'planning')
      const malformed = { action: 'hand_off', proposalId: 'not-a-uuid' } as unknown as ActionPayload
      await expect(
        submitAction(deps(sql), { userId: USER, conversationId, action: malformed, idempotencyKey: 'a1' }),
      ).rejects.toThrow()
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(0)
      const turns = await sql`select id from turns where conversation_id = ${conversationId}`
      expect(turns).toHaveLength(0)
    })
  })

  it('throws ActionRefused when the conversation is at the front desk', async () => {
    await withTestDb(async (sql) => {
      const conversationId = await insertConversation(sql, 'front')
      await expect(
        submitAction(deps(sql), { userId: USER, conversationId, action: HAND_OFF, idempotencyKey: 'a1' }),
      ).rejects.toBeInstanceOf(ActionRefused)
      const msgs = await sql`select id from messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(0)   // nothing written on refusal
    })
  })

  it('never creates a conversation', async () => {
    await withTestDb(async (sql) => {
      const before = await sql`select count(*)::int as n from conversations`
      await expect(
        submitAction(deps(sql), {
          userId: USER, conversationId: '55555555-5555-5555-5555-555555555555',
          action: HAND_OFF, idempotencyKey: 'a1',
        }),
      ).rejects.toThrow()
      const after = await sql`select count(*)::int as n from conversations`
      expect(after[0]!.n).toBe(before[0]!.n)
    })
  })
})
