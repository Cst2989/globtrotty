import { submitMessage } from '../src/handler.js'
import { finishTurn, loadTurnInput } from '../src/repo/turns.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = '11111111-1111-1111-1111-111111111111'

describeDb('loadTurnInput', () => {
  it('returns the message the turn was queued for', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {} }, {
        userId: USER, conversationId: null, message: 'a week in Portugal',
      })
      const input = await loadTurnInput(sql, submitted.turnId)
      expect(input?.message).toBe('a week in Portugal')
      expect(input?.conversationId).toBe(submitted.conversationId)
    })
  })

  it('returns null for a turn that has already run', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {} }, {
        userId: USER, conversationId: null, message: 'hi',
      })
      const input = (await loadTurnInput(sql, submitted.turnId))!
      await finishTurn(sql, input, 'Two options near Faro.')
      expect(await loadTurnInput(sql, submitted.turnId)).toBeNull()
    })
  })

  // The reason the join is on the turn id and not on the conversation.
  it('ignores a later message on the same conversation', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {} }, {
        userId: USER, conversationId: null, message: 'a week in Portugal',
      })
      // She types again while the turn is still queued. Lesson 2.7 makes this
      // the 'busy' path; today it is just another row with no turn of its own.
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${submitted.conversationId}, ${USER}, null, 'user', 'and I forgot the crib')`
      const input = await loadTurnInput(sql, submitted.turnId)
      expect(input?.message).toBe('a week in Portugal')
    })
  })
})

describeDb('finishTurn', () => {
  it('writes the reply and closes the turn together', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage({ sql, invoke: async () => {} }, {
        userId: USER, conversationId: null, message: 'hi',
      })
      const input = (await loadTurnInput(sql, submitted.turnId))!
      await finishTurn(sql, input, 'Two options near Faro.')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe('Two options near Faro.')
      const [t] = await sql`select status, finished_at from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.finished_at).not.toBeNull()
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('active')
    })
  })
})
