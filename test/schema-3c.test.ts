import { expect, it } from 'vitest'
import { withTestDb, describeDb } from './helpers/db.js'

const USER = '00000000-0000-4000-8000-00000000c001'

describeDb('0015 plan 3c schema', () => {
  it('starts a new conversation at the front desk', async () => {
    await withTestDb(async (sql) => {
      const [c] = await sql`insert into conversations (user_id) values (${USER}) returning desk, front_label`
      expect(c!.desk).toBe('front')
      expect(c!.front_label).toBeNull()
    })
  })
  it('accepts the four front labels and refuses anything else', async () => {
    await withTestDb(async (sql) => {
      for (const l of ['new_trip', 'faq', 'unclear', 'fallback']) {
        const [c] = await sql`insert into conversations (user_id, front_label) values (${USER}, ${l}) returning front_label`
        expect(c!.front_label).toBe(l)
      }
      await expect(sql`insert into conversations (user_id, front_label) values (${USER}, 'greeting')`)
        .rejects.toThrow(/check constraint/i)
    })
  })
  it('stores a canary run and a drift alarm', async () => {
    await withTestDb(async (sql) => {
      const [r] = await sql`
        insert into canary_runs (seat, model, stop_reason, output_band, signal, request_id)
        values ('driver', 'claude-opus-5', 'tool_use', 'm', 'explore_flights', 'req_x') returning id, ran_at`
      expect(r!.ran_at).toBeInstanceOf(Date)
      const [a] = await sql`
        insert into drift_alarms (seat, "check", detail) values ('driver', 'canary', ${sql.json({ from: 'a', to: 'b' })})
        returning id, notified_at`
      expect(a!.notified_at).toBeNull()
      // Each rejected insert gets its OWN savepoint: a failing statement
      // aborts the enclosing transaction, so without this the second
      // assertion would see "current transaction is aborted" instead of the
      // check-constraint error it is meant to prove (test/schema.test.ts hit
      // this same bug already).
      await expect(sql.begin((tx) => tx`
        insert into canary_runs (seat, model, stop_reason, output_band, signal) values ('nobody', 'm', 's', 'm', '')`))
        .rejects.toThrow(/check constraint/i)
      await expect(sql.begin((tx) => tx`
        insert into drift_alarms (seat, "check", detail) values ('driver', 'vibes', '{}')`))
        .rejects.toThrow(/check constraint/i)
    })
  })
})
