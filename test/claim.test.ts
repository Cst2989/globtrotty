import { describe, it, expect } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { claimTurn, saveTurnState, releaseForContinuation, FencedError } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedTurn(sql: postgres.Sql) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c!.id}, ${USER}, 'k1') returning *`
  return t!
}

describeDb('claimTurn', () => {
  it('claims a queued turn and increments attempts', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const claim = await claimTurn(sql, t.id)
      expect(claim?.attempts).toBe(1)
    })
  })

  it('refuses a second claim of a live turn', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      expect(await claimTurn(sql, t.id)).not.toBeNull()
      expect(await claimTurn(sql, t.id)).toBeNull()   // the Netlify retry: a silent no-op
    })
  })

  it('reclaims a turn whose heartbeat has gone silent', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      await claimTurn(sql, t.id)
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      const second = await claimTurn(sql, t.id)
      expect(second?.attempts).toBe(2)
    })
  })

  it('refuses to reclaim past the crash-loop cap', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      await sql`update turns set status='running', attempts = 5,
                heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      expect(await claimTurn(sql, t.id)).toBeNull()
    })
  })

  // The lease bug: claiming is exclusive, writing was not.
  it('REJECTS a write from a superseded worker', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      const second = (await claimTurn(sql, t.id))!

      await saveTurnState(sql, second, { step: 3, messages: [], reviewRounds: 0 })

      await expect(
        saveTurnState(sql, first, { step: 1, messages: [], reviewRounds: 0 }),
      ).rejects.toThrow(FencedError)

      const [row] = await sql`select state from turns where id = ${t.id}`
      expect(row!.state.step).toBe(3)      // the live worker's state survived
    })
  })
})

describeDb('releaseForContinuation', () => {
  // CRITICAL 2: saveTurnState alone leaves status='running' with a fresh
  // heartbeat_at, so the re-invocation's own claimTurn can satisfy neither the
  // 'queued' nor the stale-heartbeat branch and returns null. This is the
  // property that must hold instead: immediately claimable by a fresh worker.
  it('makes a turn immediately claimable by a fresh claimTurn', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const claim = (await claimTurn(sql, t.id))!

      await releaseForContinuation(sql, claim, { step: 1, messages: [], reviewRounds: 0 })

      const [row] = await sql`select status, heartbeat_at from turns where id = ${t.id}`
      expect(row!.status).toBe('queued')

      const second = await claimTurn(sql, t.id)
      expect(second).not.toBeNull()
      expect(second?.attempts).toBe(2)
      expect(second?.state).toEqual({ step: 1, messages: [], reviewRounds: 0 })
    })
  })

  it('rejects a fenced release', async () => {
    await withTestDb(async (sql) => {
      const t = await seedTurn(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      await claimTurn(sql, t.id)   // a second worker supersedes the first

      await expect(
        releaseForContinuation(sql, first, { step: 9, messages: [], reviewRounds: 0 }),
      ).rejects.toThrow(FencedError)
    })
  })
})
