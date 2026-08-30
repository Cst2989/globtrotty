import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { claimTurn, loadTurnInput, saveTurnState, FencedError, MAX_ATTEMPTS } from '../src/repo/turns.js'
import { describeDb, withRealDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'

// Fresh per run: a fixed literal is also the id scripts/trip.ts commits real
// rows for, and those rows outlive this test's rolled-back transaction.
const USER = randomUUID()

/**
 * Tier 3's body exactly as lesson 2.2 shipped it: read the turn and her
 * message, write the reply, close the turn. Spelled out in SQL rather than
 * called through src/repo/turns.ts, so this demonstration keeps working after
 * lesson 3.3 replaces those functions.
 */
async function tier3AsItWas(sql: postgres.Sql, turnId: string, reply: string): Promise<boolean> {
  const rows = await sql`
    select t.id, t.conversation_id, t.user_id, m.content
      from course.turns t
      join course.messages m on m.turn_id = t.id and m.role = 'user'
     where t.id = ${turnId} and t.status = 'queued'`
  const row = rows[0]
  if (!row) return false
  await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
            values (${row.conversation_id}, ${row.user_id}, ${turnId}, 'agent', ${reply})`
  await sql`update course.turns set status = 'done', finished_at = now() where id = ${turnId}`
  return true
}

describeDb('two invocations of one turn, before this lesson', () => {
  it('both run it, and she is answered twice', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'k1',
      })
      // Both read before either writes, which is the whole race: Netlify's own
      // retry of a background invocation looks exactly like this.
      const [a, b] = await Promise.all([
        tier3AsItWas(sql, submitted.turnId!, 'Two hotels near the beach.'),
        tier3AsItWas(sql, submitted.turnId!, 'Two completely different hotels.'),
      ])
      expect([a, b]).toEqual([true, true])
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.filter((m) => m.role === 'agent')).toHaveLength(2)
    })
  })
})

describeDb('claimTurn', () => {
  it('claims a queued turn and increments attempts', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c1',
      })
      const claim = await claimTurn(sql, submitted.turnId!)
      expect(claim?.attempts).toBe(1)
      expect(claim?.conversationId).toBe(submitted.conversationId)
      expect(claim?.state).toBeNull()
      const [t] = await sql`select status, started_at, heartbeat_at from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('running')
      expect(t!.started_at).not.toBeNull()
      expect(t!.heartbeat_at).not.toBeNull()
    })
  })

  it('refuses a second claim of a live turn', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c2',
      })
      expect(await claimTurn(sql, submitted.turnId!)).not.toBeNull()
      // The Netlify retry, and the sweeper's re-invocation: a silent no-op, not
      // a second run and not an error anybody has to handle.
      expect(await claimTurn(sql, submitted.turnId!)).toBeNull()
    })
  })

  it('refuses a turn that has already finished', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c3',
      })
      await sql`update course.turns set status = 'done', finished_at = now() where id = ${submitted.turnId}`
      expect(await claimTurn(sql, submitted.turnId!)).toBeNull()
    })
  })

  it('refuses to claim past the crash-loop cap', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c4',
      })
      await sql`update course.turns set attempts = ${MAX_ATTEMPTS} where id = ${submitted.turnId}`
      expect(await claimTurn(sql, submitted.turnId!)).toBeNull()
    })
  })

  it('a claimed turn is still loadable, which is why the worker may claim first', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'c7',
      })
      await claimTurn(sql, submitted.turnId!)
      // The claim set 'running'. If loadTurnInput still filtered on 'queued'
      // alone, the worker would claim a turn and then read nothing.
      const input = await loadTurnInput(sql, submitted.turnId!)
      expect(input?.message).toBe('a week in Portugal')
    })
  })
})

/**
 * The half a claim on its own does not buy. Claiming is exclusive; writing was
 * not. A worker the platform killed can still have a write in flight, because
 * the platform kills the function and not the statement Postgres has already
 * received, so a dead worker's late save can land on top of a live worker's
 * state. `attempts` is the fencing token: the claim already computed it, and
 * `saveTurnState`'s write carries it or is refused. The completion write
 * (`completeTurn`, `failTurn`, from lesson 3.3) carries this same token now.
 */
describeDb('saveTurnState', () => {
  it('rejects a write from a superseded worker and keeps the live one', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c5',
      })
      const first = (await claimTurn(sql, submitted.turnId!))!
      // Put the turn back on the queue so a second worker can legitimately take
      // it. Lesson 3.2 is what makes this happen on its own, from a heartbeat
      // going silent; here it is done by hand so the fencing token is the only
      // thing under test.
      await sql`update course.turns set status = 'queued' where id = ${submitted.turnId}`
      const second = (await claimTurn(sql, submitted.turnId!))!
      expect(second.attempts).toBe(2)

      await saveTurnState(sql, second, { step: 3, messages: [] })
      await expect(saveTurnState(sql, first, { step: 1, messages: [] })).rejects.toThrow(FencedError)

      const [row] = await sql`select state from course.turns where id = ${submitted.turnId}`
      expect(row!.state).toEqual({ step: 3, messages: [] })   // the live worker's state survived
    })
  })

  it('rejects a write to a turn that is no longer running', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'hi', idempotencyKey: 'c6',
      })
      const claim = (await claimTurn(sql, submitted.turnId!))!
      await sql`update course.turns set status = 'done' where id = ${submitted.turnId}`
      await expect(saveTurnState(sql, claim, { step: 1, messages: [] })).rejects.toThrow(FencedError)
    })
  })
})

describeDb('claimTurn, under a real race', () => {
  it('lets exactly one of two concurrent claims win', async () => {
    await withRealDb(async (sql, userId) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'race-1',
      })
      // Two connections out of the same pool, racing: whichever way the two
      // statements interleave, exactly one row matches. This is the shape
      // Netlify's own retry produces, and the one a single serialised
      // connection cannot produce at all.
      const [a, b] = await Promise.all([
        claimTurn(sql, submitted.turnId!),
        claimTurn(sql, submitted.turnId!),
      ])
      expect([a, b].filter((claim) => claim !== null)).toHaveLength(1)

      const [t] = await sql`select status, attempts from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('running')
      // The loser matched zero rows, so it incremented nothing: two claims of
      // one turn cost one attempt, not two. `attempts` counts times TRIED
      // rather than times claimed, and from lesson 3.5 the sweeper's own
      // requeue advances it with no worker involved at all
      // (src/sweeper.ts, test/sweeper.test.ts); what makes it a fencing token
      // is that it only ever moves forward, not what it counts.
      expect(t!.attempts).toBe(1)
    })
  })
})
