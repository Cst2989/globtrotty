import { randomUUID } from 'node:crypto'
import { FAIL_REASONS } from '../src/engine.js'
import { SEATS, type SeatName } from '../src/seats.js'
import { describeDb, withTestDb } from './helpers/db.js'

// Imported, not retyped: a hand-copied array would only be checked for
// assignability to FailReason, not for matching it exactly, so a reason added
// to the union and forgotten here would leave this test green and the
// constraint silently out of date.
const REASONS = FAIL_REASONS

// Fresh per run: the fixed literal is the id the scripts commit real rows for,
// and those rows outlive a rolled-back transaction for the rest of the UTC day.
const USER = randomUUID()

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

  // The handler's read-back after `on conflict do nothing` (src/handler.ts)
  // assumes zero rows means one of the REFUSABLE constraints refused, and tells
  // duplicate from busy by checking only the first by name. A unique index
  // added to this table later could make some other refusal look like one of
  // those two, silently, which is why this pins the whole set rather than just
  // that each one individually still throws. `turns_user_idempotency` is
  // scoped to (user_id, idempotency_key), not (conversation_id,
  // idempotency_key), so a first press with no conversation yet can still be
  // recognised (src/handler.ts's `firstPress`).
  //
  // The third entry, `turns_id_user_id_key`, is lesson 5.6's and is not a
  // refusal this read-back can ever meet. It exists so course.user_memory can
  // carry a COMPOSITE foreign key to (id, user_id) and a fact cannot cite
  // another traveller's turn (migration 0016), and the only insert that could
  // conflict on it is one whose `id` collides with an existing row's, which is
  // a gen_random_uuid() collision and not a press arriving twice. It is listed
  // here because an unlisted unique index is exactly what this case exists to
  // catch, including a deliberate one.
  it('carries exactly the unique indexes the on-conflict read-back tells apart', async () => {
    await withTestDb(async (sql) => {
      const idx = await sql`
        select indexname from pg_indexes
         where schemaname = 'course' and tablename = 'turns'
           and indexdef ilike '%unique%' and indexname <> 'turns_pkey'
         order by indexname`
      expect(idx.map((r) => r.indexname)).toEqual([
        'turns_id_user_id_key', 'turns_one_active_per_conversation', 'turns_user_idempotency',
      ])
    })
  })

  // The pair is (user_id, idempotency_key), not (conversation_id,
  // idempotency_key), because a first press has no conversation yet to scope
  // the key to. Same key, same user, two DIFFERENT conversations: the second
  // insert must be refused.
  it('scopes the idempotency key to the user, not to one conversation', async () => {
    await withTestDb(async (sql) => {
      const [c1] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      const [c2] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await sql`insert into course.turns (conversation_id, user_id, idempotency_key)
                values (${c1!.id}, ${USER}, 'same-key')`
      await expect(
        sql`insert into course.turns (conversation_id, user_id, idempotency_key)
            values (${c2!.id}, ${USER}, 'same-key')`,
      ).rejects.toThrow(/turns_user_idempotency/)
    })
  })

  it('accepts every seat name the code can produce', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      for (const name of Object.keys(SEATS) as SeatName[]) {
        await sql`
          insert into course.model_calls (conversation_id, user_id, seat, prompt_version,
                                          model_requested, model_returned)
          values (${c!.id}, ${USER}, ${name}, 'v', ${SEATS[name].model}, ${SEATS[name].model})`
      }
      const rows = await sql`select seat from course.model_calls where conversation_id = ${c!.id}`
      expect(rows).toHaveLength(Object.keys(SEATS).length)
    })
  })

  it('refuses a seat nobody declared', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into course.conversations (user_id) values (${USER}) returning id`
      await expect(
        sql`insert into course.model_calls (conversation_id, user_id, seat, prompt_version,
                                            model_requested, model_returned)
            values (${c!.id}, ${USER}, 'concierge', 'v', 'claude-opus-5', 'claude-opus-5')`,
      ).rejects.toThrow(/model_calls_seat_check/)
    })
  })
})
