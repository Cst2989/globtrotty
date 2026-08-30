import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import {
  claimTurn, heartbeat, releaseForContinuation, FencedError, HEARTBEAT_STALE, MAX_ATTEMPTS,
} from '../src/repo/turns.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()
const deps = (sql: postgres.Sql) => ({ sql, limits: DEFAULT_LIMITS, invoke: async () => {} })

async function queuedTurn(sql: postgres.Sql, key: string): Promise<string> {
  const submitted = await submitMessage(deps(sql), {
    userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key,
  })
  return submitted.turnId!
}

/** Silence, made to have happened, by moving the last heartbeat into the past. */
async function silentFor(sql: postgres.Sql, turnId: string, seconds: number): Promise<void> {
  await sql`update course.turns
               set heartbeat_at = now() - make_interval(secs => ${seconds})
             where id = ${turnId}`
}

describeDb('the lease', () => {
  it('reclaims a turn whose worker has gone silent', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l1')
      const first = (await claimTurn(sql, turnId))!
      expect(first.attempts).toBe(1)
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      const second = await claimTurn(sql, turnId)
      expect(second?.attempts).toBe(2)
    })
  })

  it('leaves a turn alone one second inside the threshold', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l2')
      await claimTurn(sql, turnId)
      await silentFor(sql, turnId, HEARTBEAT_STALE - 1)
      expect(await claimTurn(sql, turnId)).toBeNull()
    })
  })

  it('still refuses to reclaim a silent turn past the crash-loop cap', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l3')
      await sql`update course.turns set status = 'running', attempts = ${MAX_ATTEMPTS} where id = ${turnId}`
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      expect(await claimTurn(sql, turnId)).toBeNull()
    })
  })
})

/**
 * The hazard the lease creates. A step that takes longer than the threshold is
 * not a dead worker, and a lease with no way to say "still here" cannot tell the
 * two apart. The heartbeat is that sentence.
 */
describeDb('heartbeat', () => {
  it('keeps a slow but living worker from being reclaimed', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l4')
      const claim = (await claimTurn(sql, turnId))!
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      // The worker is alive and says so, which is all a heartbeat is.
      await heartbeat(sql, claim)
      expect(await claimTurn(sql, turnId)).toBeNull()
    })
  })

  it('refuses a heartbeat from a superseded worker while the live one succeeds', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l5')
      const first = (await claimTurn(sql, turnId))!
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      const second = (await claimTurn(sql, turnId))!

      await expect(heartbeat(sql, first)).rejects.toThrow(FencedError)
      await expect(heartbeat(sql, second)).resolves.toBeUndefined()

      const [row] = await sql`select attempts from course.turns where id = ${turnId}`
      expect(row!.attempts).toBe(2)
    })
  })
})

/**
 * Handing the lease back on purpose. `decideNext` answers `continue_later` when
 * the next step would not fit before the deadline (lesson 2.3), and the turn has
 * to become claimable again immediately, not after a staleness window.
 */
describeDb('releaseForContinuation', () => {
  it('makes a turn immediately claimable, with its state kept', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l6')
      const claim = (await claimTurn(sql, turnId))!

      await releaseForContinuation(sql, claim, { step: 1 })

      const [row] = await sql`select status, state from course.turns where id = ${turnId}`
      expect(row!.status).toBe('queued')
      expect(row!.state).toEqual({ step: 1 })

      // No staleness wait: the queued arm of claimTurn has no time condition at
      // all, which is the property saveTurnState alone cannot give.
      const second = await claimTurn(sql, turnId)
      expect(second?.attempts).toBe(2)
      expect(second?.state).toEqual({ step: 1 })
    })
  })

  it('refuses a release from a superseded worker', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l7')
      const first = (await claimTurn(sql, turnId))!
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      await claimTurn(sql, turnId)
      await expect(releaseForContinuation(sql, first, { step: 9 })).rejects.toThrow(FencedError)
    })
  })
})
