import { vi } from 'vitest'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { describeDb, withRealDb } from './helpers/db.js'

// Raised so a busy development database's own spend today cannot turn any of
// these into a limit_reached test by accident; these tests are about
// idempotency, not ceilings. withRealDb commits for real and its own contract
// is that it only ever touches this test's invented user, so the ceiling is
// raised out of the way rather than cleared for every other user's rows.
const LIMITS = { ...DEFAULT_LIMITS, globalCeilingMicros: 2n ** 62n }

describeDb('fifty first presses of Send', () => {
  // The bug fix round 3 closes: before it, the key was scoped to
  // (conversation_id, idempotency_key), and a first press has no
  // conversation yet, so submitMessage created a fresh one before the key
  // was ever compared. Fifty concurrent first presses of the SAME key must
  // now buy exactly one conversation, the same "one" the test below already
  // pins for an existing conversation.
  it('buy exactly one conversation, one turn and one message', async () => {
    await withRealDb(async (sql, userId) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps = { sql, limits: LIMITS, invoke }
      const press = () => submitMessage(deps, {
        userId, conversationId: null, message: 'a week in Portugal in September',
        idempotencyKey: 'first-press',
      })

      const results = await Promise.all(Array.from({ length: 50 }, press))

      const conversationIds = new Set(results.map((r) => r.conversationId))
      expect(conversationIds.size).toBe(1)
      const conversationId = [...conversationIds][0]!
      const turns = await sql`select id from course.turns where conversation_id = ${conversationId}`
      expect(turns).toHaveLength(1)
      expect(results.filter((r) => r.status === 'queued')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(49)
      expect(invoke).toHaveBeenCalledTimes(1)
      const msgs = await sql`select turn_id from course.messages where conversation_id = ${conversationId}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.turn_id).toBe(turns[0]!.id)

      // The one conversation the fifty presses agreed on is this user's own,
      // not some other invented id a bug in the resolution might have handed
      // back.
      const conv = await sql`select user_id from course.conversations where id = ${conversationId}`
      expect(conv[0]!.user_id).toBe(userId)

      // And it is the ONLY conversation row this user has. Everything above
      // reads the results the presses returned, so all fifty could agree on one
      // id while forty-nine losers left a committed conversation nobody will
      // ever see: the rollback of the losing transaction is exactly the thing
      // the fix depends on, and this counts it. withRealDb's cleanup deletes
      // the evidence afterwards, so it has to be counted here or not at all.
      const [convCount] = await sql`select count(*)::int as n from course.conversations
                                     where user_id = ${userId}`
      expect(convCount!.n).toBe(1)
    })
  })

  // A DIFFERENT key from the same user, still with no conversation given,
  // is a different first press, not a retry: it must start its own
  // conversation rather than being folded into the one above.
  it('start a second conversation for a second key from the same user', async () => {
    await withRealDb(async (sql, userId) => {
      const deps = { sql, limits: LIMITS, invoke: vi.fn().mockResolvedValue(undefined) }
      const first = await submitMessage(deps, {
        userId, conversationId: null, message: 'one', idempotencyKey: 'press-a',
      })
      const second = await submitMessage(deps, {
        userId, conversationId: null, message: 'two', idempotencyKey: 'press-b',
      })
      expect(second.conversationId).not.toBe(first.conversationId)
      expect(first.status).toBe('queued')
      expect(second.status).toBe('queued')
    })
  })
})

// The global ceiling is lowered instead of raising this account's committed
// spend: withRealDb commits for real, and a real $50 daily_usage row would be
// visible to every other test's global read for the rest of the UTC day.
// Zero means every account is over it, which is the branch under test.
const CAPPED_LIMITS = { ...DEFAULT_LIMITS, globalCeilingMicros: 0n }

// Defect A from the fix3 re-review. The capped branch of a first press opens no
// turn (turnId stays null, which is the documented contract), so course.turns
// cannot serialise two of them; before fix round 4, fifty concurrent capped
// first presses of one key bought fifty conversations, forty-nine of them empty,
// and handed back a different conversationId every time. Her message key,
// claimed inside the same transaction that creates the conversation, is what
// makes them one press.
describeDb('fifty capped first presses of Send', () => {
  it('buy one denied conversation, one message and one reply, and no turn', async () => {
    await withRealDb(async (sql, userId) => {
      const invoke = vi.fn()
      const deps = { sql, limits: CAPPED_LIMITS, invoke }
      const press = () => submitMessage(deps, {
        userId, conversationId: null, message: 'a week in Portugal in September',
        idempotencyKey: 'capped-first-press',
      })

      const results = await Promise.all(Array.from({ length: 50 }, press))

      expect(results.every((r) => r.status === 'limit_reached')).toBe(true)
      // No turn was opened, on any of the fifty, so none of them can name one.
      expect(results.every((r) => r.turnId === null)).toBe(true)
      const conversationIds = new Set(results.map((r) => r.conversationId))
      expect(conversationIds.size).toBe(1)

      // One conversation row, not fifty: forty-nine of these presses created
      // one inside a transaction that rolled back.
      const convs = await sql`select id, status from course.conversations where user_id = ${userId}`
      expect(convs).toHaveLength(1)
      expect(convs[0]!.id).toBe([...conversationIds][0]!)
      expect(convs[0]!.status).toBe('limit_reached')

      const turns = await sql`select id from course.turns where user_id = ${userId}`
      expect(turns).toHaveLength(0)

      // Her sentence once, and one reply naming the ceiling that stopped it:
      // the same two rows a single capped press leaves.
      const msgs = await sql`select role, content, turn_id from course.messages
                              where user_id = ${userId} order by seq`
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.content).toBe('a week in Portugal in September')
      expect(msgs[0]!.turn_id).toBeNull()
      expect(msgs[1]!.role).toBe('agent')
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.account)
      // Nothing ran, so nothing was spent: the point of denying before a turn.
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})

describeDb('fifty presses of Send', () => {
  it('buy exactly one turn', async () => {
    await withRealDb(async (sql, userId) => {
      const [conversation] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps = { sql, limits: LIMITS, invoke }
      const press = () => submitMessage(deps, {
        userId,
        conversationId: conversation!.id as string,
        message: 'a week in Portugal in September',
        idempotencyKey: 'the-same-press',
      })

      const results = await Promise.all(Array.from({ length: 50 }, press))

      const turns = await sql`select id from course.turns where conversation_id = ${conversation!.id}`
      expect(turns).toHaveLength(1)
      const turnIds = new Set(results.map((r) => r.turnId))
      expect(turnIds.size).toBe(1)
      expect(results.filter((r) => r.status === 'queued')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(49)
      // One turn opened means the work started once, not fifty times: the
      // half of "fifty presses buy one turn" that costs money if it is wrong.
      expect(invoke).toHaveBeenCalledTimes(1)

      // One turn and ONE MESSAGE. Deduping only the turn would leave fifty
      // copies of her sentence in the thread, which is what she would actually
      // see, and would fill every line `npm run messages` prints.
      const msgs = await sql`select turn_id from course.messages where conversation_id = ${conversation!.id}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.turn_id).toBe(turns[0]!.id)
    })
  })

  it('does not open a second turn for a different message while one is in flight', async () => {
    await withRealDb(async (sql, userId) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps = { sql, limits: LIMITS, invoke }
      const first = await submitMessage(deps, {
        userId, conversationId: null, message: 'one', idempotencyKey: 'k1',
      })
      const second = await submitMessage(deps, {
        userId, conversationId: first.conversationId, message: 'two, and I forgot the crib',
        idempotencyKey: 'k2',
      })
      expect(second.status).toBe('busy')
      expect(second.turnId).toBeNull()
      expect(invoke).toHaveBeenCalledTimes(1)
      const turns = await sql`select id from course.turns where conversation_id = ${first.conversationId}`
      expect(turns).toHaveLength(1)
      // Busy is not the same as ignored: what she typed is kept, with no turn of
      // its own, and the running turn can pick it up in module 3.
      const msgs = await sql`select content, turn_id from course.messages
                              where conversation_id = ${first.conversationId} order by seq`
      expect(msgs.map((m) => m.content)).toEqual(['one', 'two, and I forgot the crib'])
      expect(msgs[0]!.turn_id).toBe(first.turnId)
      expect(msgs[1]!.turn_id).toBeNull()
    })
  })

  // Busy opens no turn, so course.turns has nothing to dedupe a retry of the
  // second message against. Without the same idempotency key on
  // course.messages too (this fix round), fifty retries of a message that
  // landed busy would write fifty copies of it, the exact failure this
  // lesson's headline claims to prevent for the first message.
  it('does not write fifty copies of the second message while it is busy', async () => {
    await withRealDb(async (sql, userId) => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      const deps = { sql, limits: LIMITS, invoke }
      const first = await submitMessage(deps, {
        userId, conversationId: null, message: 'one', idempotencyKey: 'k1',
      })
      const press = () => submitMessage(deps, {
        userId, conversationId: first.conversationId, message: 'two, and I forgot the crib',
        idempotencyKey: 'k2',
      })

      const results = await Promise.all(Array.from({ length: 50 }, press))

      expect(results.every((r) => r.status === 'busy')).toBe(true)
      const turns = await sql`select id from course.turns where conversation_id = ${first.conversationId}`
      expect(turns).toHaveLength(1)
      const msgs = await sql`select id from course.messages
                              where conversation_id = ${first.conversationId} and idempotency_key = 'k2'`
      expect(msgs).toHaveLength(1)
    })
  })
})
