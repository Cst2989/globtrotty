import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { describeDb, withRealDb } from './helpers/db.js'

describeDb('fifty presses of Send', () => {
  it('buy exactly one turn', async () => {
    await withRealDb(async (sql, userId) => {
      // withRealDb commits for real and only ever deletes THIS test's rows, but
      // readSpendFailClosed's global ceiling sums every user's spend today. A
      // development database that already holds today's $50 would deny all
      // fifty presses for a reason that has nothing to do with idempotency, so
      // today's ledger is cleared first, exactly as the handler's own
      // global-ceiling tests clear it before asserting against it.
      await sql`delete from course.daily_usage where day = (now() at time zone 'utc')::date`
      const [conversation] = await sql`insert into course.conversations (user_id) values (${userId}) returning id`
      const deps = { sql, limits: DEFAULT_LIMITS, invoke: async () => {} }
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

      // One turn and ONE MESSAGE. Deduping only the turn would leave fifty
      // copies of her sentence in the thread, which is what she would actually
      // see, and `npm run messages` would print it ten times.
      const msgs = await sql`select turn_id from course.messages where conversation_id = ${conversation!.id}`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.turn_id).toBe(turns[0]!.id)
    })
  })

  it('does not open a second turn for a different message while one is in flight', async () => {
    await withRealDb(async (sql, userId) => {
      // Same reason as the test above: clear today's global ledger before the
      // ceiling check runs, so a busy development database cannot turn this
      // into a limit_reached test by accident.
      await sql`delete from course.daily_usage where day = (now() at time zone 'utc')::date`
      const deps = { sql, limits: DEFAULT_LIMITS, invoke: async () => {} }
      const first = await submitMessage(deps, {
        userId, conversationId: null, message: 'one', idempotencyKey: 'k1',
      })
      const second = await submitMessage(deps, {
        userId, conversationId: first.conversationId, message: 'two, and I forgot the crib',
        idempotencyKey: 'k2',
      })
      expect(second.status).toBe('busy')
      expect(second.turnId).toBeNull()
      // Busy is not the same as ignored: what she typed is kept, with no turn of
      // its own, and the running turn can pick it up in module 3.
      const msgs = await sql`select content, turn_id from course.messages
                              where conversation_id = ${first.conversationId} order by seq`
      expect(msgs.map((m) => m.content)).toEqual(['one', 'two, and I forgot the crib'])
      expect(msgs[0]!.turn_id).toBe(first.turnId)
      expect(msgs[1]!.turn_id).toBeNull()
    })
  })
})
