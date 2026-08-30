import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'
import { describeDb, withTestDb } from './helpers/db.js'

const USER = randomUUID()

async function seedTurn(sql: postgres.Sql, key: string): Promise<string> {
  const submitted = await submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
    { userId: USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: key },
  )
  return submitted.turnId!
}

describeDb('the tool-call ledger', () => {
  it('reports a first call as fresh', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql, 't1')
      expect(await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')).toEqual({ status: 'fresh' })
    })
  })

  it('replays a completed call instead of running it again', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql, 't2')
      await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')
      await finishToolCall(sql, turnId, 's1-b0', { content: '[{"name":"Vila Lagos"}]', isError: false })
      expect(await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')).toEqual({
        status: 'replayed', result: { content: '[{"name":"Vila Lagos"}]', isError: false },
      })
    })
  })

  // The dangerous case, and the reason the row is written before the call runs.
  it('reports a pending call as ambiguous rather than guessing either way', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql, 't3')
      await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')
      expect(await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')).toEqual({ status: 'ambiguous' })
    })
  })

  it('replays a stored null without confusing it for no result', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql, 't4')
      await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')
      await finishToolCall(sql, turnId, 's1-b0', null)
      expect(await beginToolCall(sql, turnId, 's1-b0', 'search_hotels'))
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
      const turnId = await seedTurn(sql, 't7')
      await expect(finishToolCall(sql, turnId, 's9-b9', { ok: true })).rejects.toThrow()
    })
  })

  it('refuses to overwrite a call that is already done', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql, 't8')
      await beginToolCall(sql, turnId, 's1-b0', 'search_hotels')
      await finishToolCall(sql, turnId, 's1-b0', { first: true })
      await expect(finishToolCall(sql, turnId, 's1-b0', { second: true })).rejects.toThrow()
      expect(await beginToolCall(sql, turnId, 's1-b0', 'search_hotels'))
        .toEqual({ status: 'replayed', result: { first: true } })
    })
  })
})
