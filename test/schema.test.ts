import { expect, it, describe } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import type { FailReason } from '../src/engine.js'

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

/**
 * 0010. `turns.fail_reason` had eight values and none of them could express what
 * plan 3's model client will actually meet: an HTTP 200 refusal, and a permanent
 * request fault that must never be retried. Both used to be written as
 * `provider_down` — a lie the sweeper and any later dashboard would believe.
 */
describeDb('0010 turns.fail_reason — the model-failure taxonomy', () => {
  /**
   * Written out literally rather than derived, so the DB check constraint is
   * pinned against a hand-checked list. The two conditionals below make it a
   * compile error for `FailReason` and this list to disagree in EITHER
   * direction — a value added to the union without a migration, or a value
   * left here after being dropped from the union.
   */
  const ALL_REASONS = [
    'provider_down', 'fetch_failed', 'limit_reached', 'step_cap',
    'deadline_exceeded', 'crash_loop', 'fenced', 'stalled',
    'refused', 'provider_rejected', 'unclassified',
  ] as const
  type Listed = (typeof ALL_REASONS)[number]
  const _coversUnion: [Exclude<FailReason, Listed>] extends [never] ? true : never = true
  const _noStrays: [Exclude<Listed, FailReason>] extends [never] ? true : never = true
  void _coversUnion
  void _noStrays

  it.each(ALL_REASONS)('accepts fail_reason %s', async (reason) => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      const [t] = await sql`
        insert into turns (conversation_id, user_id, idempotency_key, status, fail_reason)
        values (${c.id}, ${USER}, ${'k-' + reason}, 'failed', ${reason})
        returning fail_reason`
      expect(t!.fail_reason).toBe(reason)
    })
  })

  it('still rejects a value that is not in the taxonomy', async () => {
    await withTestDb(async (sql) => {
      const c = await seedConversation(sql)
      // Each rejected insert gets its OWN savepoint: a failing statement aborts
      // the enclosing transaction, so without this the second assertion would
      // see "current transaction is aborted" instead of the check-constraint
      // error it is meant to prove. This has bitten this repo twice.
      const rejects = (reason: string) =>
        sql.begin((tx) => tx`
          insert into turns (conversation_id, user_id, idempotency_key, status, fail_reason)
          values (${c.id}, ${USER}, ${'bad-' + reason}, 'failed', ${reason})`)

      // Near-misses, not gibberish: the names a future edit would plausibly
      // reach for, each of which must still fail.
      await expect(rejects('refusal')).rejects.toThrow(/check constraint/i)
      await expect(rejects('model_refused')).rejects.toThrow(/check constraint/i)
      await expect(rejects('Refused')).rejects.toThrow(/check constraint/i)
      await expect(rejects('bad_request')).rejects.toThrow(/check constraint/i)
      await expect(rejects('')).rejects.toThrow(/check constraint/i)
    })
  })
})
