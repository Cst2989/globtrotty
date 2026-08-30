import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { AmbiguousToolCallError, beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'
import { claimTurn, FencedError, HEARTBEAT_STALE, type Claim } from '../src/repo/turns.js'
import { ledgerRunner } from '../src/tools.js'
import { describeDb, withRealDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

async function seedTurn(sql: postgres.Sql, key: string): Promise<Claim> {
  const submitted = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
    { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key },
  )
  return (await claimTurn(sql, submitted.turnId!))!
}

/** Silence, made to have happened, by moving the last heartbeat into the past (matches test/lease.test.ts). */
async function silentFor(sql: postgres.Sql, turnId: string, seconds: number): Promise<void> {
  await sql`update course.turns
               set heartbeat_at = now() - make_interval(secs => ${seconds})
             where id = ${turnId}`
}

describeDb('the tool-call ledger', () => {
  it('reports a first call as fresh', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't1')
      expect(await beginToolCall(sql, claim, 's1-b0', 'search_hotels')).toEqual({ status: 'fresh' })
    })
  })

  it('replays a completed call instead of running it again', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't2')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      await finishToolCall(sql, claim, 's1-b0', { content: '[{"name":"Vila Lagos"}]', isError: false })
      expect(await beginToolCall(sql, claim, 's1-b0', 'search_hotels')).toEqual({
        status: 'replayed', result: { content: '[{"name":"Vila Lagos"}]', isError: false },
      })
    })
  })

  // The dangerous case, and the reason the row is written before the call runs.
  it('reports a pending call as ambiguous rather than guessing either way', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't3')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      expect(await beginToolCall(sql, claim, 's1-b0', 'search_hotels')).toEqual({ status: 'ambiguous' })
    })
  })

  it('replays a stored null without confusing it for no result', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't4')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      await finishToolCall(sql, claim, 's1-b0', null)
      expect(await beginToolCall(sql, claim, 's1-b0', 'search_hotels'))
        .toEqual({ status: 'replayed', result: null })
    })
  })

  it('scopes call ids to their turn', async () => {
    await withTestDb(async (sql) => {
      const a = await seedTurn(sql, 't5')
      const b = await seedTurn(sql, 't6')
      await beginToolCall(sql, a, 's1-b0', 'search_hotels')
      expect(await beginToolCall(sql, b, 's1-b0', 'search_hotels')).toEqual({ status: 'fresh' })
    })
  })

  it('refuses to finish a call that was never begun', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't7')
      await expect(finishToolCall(sql, claim, 's9-b9', { ok: true })).rejects.toThrow()
    })
  })

  it('refuses to overwrite a call that is already done', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't8')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      await finishToolCall(sql, claim, 's1-b0', { first: true })
      await expect(finishToolCall(sql, claim, 's1-b0', { second: true })).rejects.toThrow()
      expect(await beginToolCall(sql, claim, 's1-b0', 'search_hotels'))
        .toEqual({ status: 'replayed', result: { first: true } })
    })
  })

  // Finding 2: `name` is stored precisely so a resume that reaches the same
  // position with a different tool cannot be handed the other call's result.
  // A different classification on resume is what this looks like in practice
  // (src/conversation.ts re-runs classify every time), simulated directly
  // here since the front desk itself has no tools to reach this through.
  it('refuses to replay a call whose stored name does not match, as a resume under a different classification would produce', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't9')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      await finishToolCall(sql, claim, 's1-b0', { content: '[]', isError: false })
      await expect(beginToolCall(sql, claim, 's1-b0', 'search_flights')).rejects.toThrow(
        /was recorded as search_hotels, not search_flights/,
      )
    })
  })
})

/**
 * Finding 1: the ledger is a write like every other in src/repo/turns.ts and
 * gets no exception from the fencing rule. A worker the lease has already
 * superseded must not be able to write intent, or record an outcome, for a
 * turn it no longer owns.
 */
describeDb('the ledger, fenced', () => {
  it('refuses to write intent for a turn this worker no longer owns, and lets the live worker proceed', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 't10' },
      )
      const turnId = submitted.turnId!
      const first = (await claimTurn(sql, turnId))!
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      const second = (await claimTurn(sql, turnId))!
      expect(second.attempts).toBe(2)

      await expect(beginToolCall(sql, first, 's1-b0', 'search_hotels')).rejects.toThrow(FencedError)
      expect(await beginToolCall(sql, second, 's1-b0', 'search_hotels')).toEqual({ status: 'fresh' })
    })
  })

  it('refuses to record a finish for a turn this worker no longer owns', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: 't11' },
      )
      const turnId = submitted.turnId!
      const first = (await claimTurn(sql, turnId))!
      await beginToolCall(sql, first, 's1-b0', 'search_hotels')
      await silentFor(sql, turnId, HEARTBEAT_STALE + 30)
      await claimTurn(sql, turnId)

      await expect(finishToolCall(sql, first, 's1-b0', { ok: true })).rejects.toThrow()
      // The row is still pending: the superseded worker's finish did not land.
      const [row] = await sql`select status from course.tool_calls where turn_id = ${turnId} and call_id = ${'s1-b0'}`
      expect(row!.status).toBe('pending')
    })
  })
})

/**
 * Finding 7: the claim is "a row appears here BEFORE its tool runs", proved
 * from inside the runner itself rather than by reading ledgerRunner's source.
 */
describeDb('ledgerRunner, ordering', () => {
  it('has already written the pending row by the time the runner it wraps is invoked', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't12')
      let sawStatus: string | undefined
      const checking = async (_name: string, _input: unknown, callId: string) => {
        const [row] = await sql`select status from course.tool_calls
                                  where turn_id = ${claim.turnId} and call_id = ${callId}`
        sawStatus = row?.status as string | undefined
        return { content: 'ok', isError: false }
      }
      const run = ledgerRunner(sql, claim, checking)
      await run('search_hotels', {}, 's1-b0')
      expect(sawStatus).toBe('pending')     // intent already landed, before the effect ran
    })
  })

  // Finding 9: `beginToolCall` returns `result: unknown` by design, and a
  // `jsonb` column can hold a row an older version of this code wrote. This
  // proves the replay path checks the shape rather than trusting a cast.
  it('treats a malformed stored replay as ambiguous rather than trusting an unchecked cast', async () => {
    await withTestDb(async (sql) => {
      const claim = await seedTurn(sql, 't13')
      await beginToolCall(sql, claim, 's1-b0', 'search_hotels')
      await sql`update course.tool_calls set status = 'done', result = ${sql.json({ not: 'a tool outcome' })}
                 where turn_id = ${claim.turnId} and call_id = ${'s1-b0'}`
      const run = ledgerRunner(sql, claim, async () => {
        throw new Error('must not run again: this call already has a stored result')
      })
      await expect(run('search_hotels', {}, 's1-b0')).rejects.toThrow(AmbiguousToolCallError)
    })
  })
})

/**
 * Finding 8: `on conflict do nothing` with a read-back is claimed to be race
 * safe, and every other test in this file runs on a one-connection pool
 * inside a single rolled-back transaction, so none of them actually race two
 * workers. This is the test with two real connections and a real commit.
 */
describeDb('beginToolCall, under a real race', () => {
  it('lets exactly one of two concurrent callers land fresh, and reports the other ambiguous', async () => {
    await withRealDb(async (sql, userId) => {
      const submitted = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId, conversationId: null, message: 'a week in Portugal', idempotencyKey: 'race-tc-1' },
      )
      const claim = (await claimTurn(sql, submitted.turnId!))!
      const [a, b] = await Promise.all([
        beginToolCall(sql, claim, 's1-b0', 'search_hotels'),
        beginToolCall(sql, claim, 's1-b0', 'search_hotels'),
      ])
      expect([a.status, b.status].sort()).toEqual(['ambiguous', 'fresh'])
    })
  })
})
