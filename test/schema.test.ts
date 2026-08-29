import type { FailReason } from '../src/engine.js'
import { describeDb, withTestDb } from './helpers/db.js'

const REASONS: FailReason[] = [
  'provider_down', 'fetch_failed', 'limit_reached', 'step_cap',
  'deadline_exceeded', 'crash_loop', 'fenced', 'stalled',
  'refused', 'provider_rejected', 'unclassified',
]

const USER = '11111111-1111-1111-1111-111111111111'

describeDb('the constraints and the types', () => {
  it('refuses a status nobody defined', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await expect(
        sql`insert into course.turns (conversation_id, user_id, idempotency_key, status)
            values (${c!.id}, ${USER}, 'k', 'workin')`,
      ).rejects.toThrow(/turns_status_check/)
    })
  })

  it('accepts every FailReason the code can produce', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      for (const [i, reason] of REASONS.entries()) {
        await sql`insert into course.turns (conversation_id, user_id, idempotency_key, status, fail_reason)
                  values (${c!.id}, ${USER}, ${`k${i}`}, 'failed', ${reason})`
      }
      const rows = await sql`select fail_reason from course.turns where conversation_id = ${c!.id}`
      expect(rows).toHaveLength(REASONS.length)
    })
  })

  it('refuses a fail reason the code cannot produce', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await expect(
        sql`insert into course.turns (conversation_id, user_id, idempotency_key, status, fail_reason)
            values (${c!.id}, ${USER}, 'k', 'failed', 'gave_up')`,
      ).rejects.toThrow(/turns_fail_reason_check/)
    })
  })

  it('refuses a second live turn on one conversation', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await sql`insert into course.turns (conversation_id, user_id, idempotency_key) values (${c!.id}, ${USER}, 'a')`
      await expect(
        sql`insert into course.turns (conversation_id, user_id, idempotency_key) values (${c!.id}, ${USER}, 'b')`,
      ).rejects.toThrow(/turns_one_active_per_conversation/)
    })
  })
})
