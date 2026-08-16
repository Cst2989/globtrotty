import { expect, it, describe } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedConversation(sql: postgres.Sql) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  if (!c) throw new Error('seedConversation: insert returned no row')
  return c
}

describeDb('schema invariants', () => {
  it('allows only one active turn per conversation', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key)
                values (${c.id}, ${USER}, 'a')`
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key)
            values (${c.id}, ${USER}, 'b')`,
      ).rejects.toThrow(/turns_one_active_per_conversation/)
    })
  })

  it('allows a new turn once the previous one is done', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${c.id}, ${USER}, 'a', 'done')`
      const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                            values (${c.id}, ${USER}, 'b') returning id`
      expect(t?.id).toBeTruthy()
    })
  })

  it('deduplicates on idempotency key — the 50-button-presses guard', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await sql`insert into turns (conversation_id, user_id, idempotency_key, status)
                values (${c.id}, ${USER}, 'same', 'done')`
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key, status)
            values (${c.id}, ${USER}, 'same', 'done')`,
      ).rejects.toThrow(/idempotency/)
    })
  })

  it('refuses a turn whose user_id does not match its conversation', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key)
            values (${c.id}, '22222222-2222-2222-2222-222222222222', 'x')`,
      ).rejects.toThrow()
    })
  })

  it('refuses negative spend', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`update conversations set spend_usd_micros = -1 where id = ${c.id}`,
      ).rejects.toThrow()
    })
  })

  it('refuses an unknown turn status', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      await expect(
        sql`insert into turns (conversation_id, user_id, idempotency_key, status)
            values (${c.id}, ${USER}, 'x', 'Running')`,   // wrong case: stranded forever
      ).rejects.toThrow()
    })
  })
})
