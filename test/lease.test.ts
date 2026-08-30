import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import {
  claimTurn, heartbeat, releaseForContinuation, saveTurnState,
  FencedError, HEARTBEAT_STALE, MAX_ATTEMPTS,
} from '../src/repo/turns.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps, silentFor } from './helpers/turns.js'

const USER = randomUUID()

async function queuedTurn(sql: postgres.Sql, key: string): Promise<string> {
  const submitted = await submitMessage(handlerDeps(sql), {
    userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key,
  })
  return submitted.turnId!
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
      // What the dead worker loses. No hand-queueing this time: the lease
      // expired on its own, and the old token no longer matches.
      await expect(saveTurnState(sql, first, { step: 1, messages: [] })).rejects.toThrow(FencedError)
    })
  })

  it('reclaims a running turn whose heartbeat was never set', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l1b')
      // A running row with a null heartbeat: unreachable through claimTurn
      // today, since a claim always stamps one, but 0001 leaves the column
      // nullable, so the state exists and something has to be able to get out
      // of it. queued_at, backdated past the threshold, is what
      // coalesce(heartbeat_at, queued_at) falls back to. The sweeper judges
      // the same rows by the same expression (src/sweeper.ts, indexed by
      // migration 0009), which test/sweeper.test.ts pins from its side: a
      // sweeper comparing bare heartbeat_at, as lesson 3.5's did, leaves this
      // row invisible to every arm of the floor walk while this test stays
      // green.
      await sql`update course.turns
                   set status = 'running',
                       heartbeat_at = null,
                       queued_at = now() - make_interval(secs => ${HEARTBEAT_STALE + 30})
                 where id = ${turnId}`
      const claim = await claimTurn(sql, turnId)
      expect(claim?.attempts).toBe(1)
    })
  })

  it('leaves a turn alone well inside the threshold', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l2')
      await claimTurn(sql, turnId)
      await silentFor(sql, turnId, HEARTBEAT_STALE - 30)
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
      const [row] = await sql`select attempts, state from course.turns where id = ${turnId}`
      expect(row!.attempts).toBe(claim.attempts)   // still the same run, still its token
      expect(row!.state).toEqual(claim.state)      // and still its state
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
  it('makes a turn immediately claimable, with its state and its spend kept', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l6')
      const claim = (await claimTurn(sql, turnId))!

      await releaseForContinuation(sql, claim, { step: 1, messages: [] }, 750n)

      const [row] = await sql`select status, state, spend_usd_micros from course.turns where id = ${turnId}`
      expect(row!.status).toBe('queued')
      expect(row!.state).toEqual({ step: 1, messages: [] })
      // The attempt that hands back is the only chance this money has of
      // reaching the turn's own row: a closer only ever runs on the last one.
      expect(BigInt(row!.spend_usd_micros as string)).toBe(750n)

      // No staleness wait: the queued arm of claimTurn has no time condition at
      // all, which is the property saveTurnState alone cannot give.
      const second = await claimTurn(sql, turnId)
      expect(second?.attempts).toBe(2)
      expect(second?.state).toEqual({ step: 1, messages: [] })
    })
  })

  it('refuses a release from a superseded worker', async () => {
    await withTestDb(async (sql) => {
      const turnId = await queuedTurn(sql, 'l7')
      const first = (await claimTurn(sql, turnId))!
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      await claimTurn(sql, turnId)
      await expect(releaseForContinuation(sql, first, { step: 9, messages: [] }, 0n)).rejects.toThrow(FencedError)
    })
  })
})
