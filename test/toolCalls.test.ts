import { describe, it, expect } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { beginToolCall, finishToolCall } from '../src/repo/toolCalls.js'

const USER = '11111111-1111-1111-1111-111111111111'

async function seedTurn(sql: postgres.Sql) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c!.id}, ${USER}, 'k') returning *`
  return t!.id as string
}

describeDb('tool call idempotency', () => {
  it('reports a first call as fresh', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights'))
        .toEqual({ status: 'fresh' })
    })
  })

  it('replays a completed call without re-executing it', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights')
      await finishToolCall(sql, turnId, 'toolu_1', { shortlist: ['a', 'b'] })
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'explore_flights'))
        .toEqual({ status: 'replayed', result: { shortlist: ['a', 'b'] } })
    })
  })

  // The dangerous case: we died mid-side-effect and cannot know if the email was sent.
  it('reports a pending call as ambiguous rather than guessing', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await beginToolCall(sql, turnId, 'toolu_1', 'escalate_to_human')
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'escalate_to_human'))
        .toEqual({ status: 'ambiguous' })
    })
  })

  it('scopes call ids to their turn', async () => {
    await withTestDb(async (sql) => {
      const a = await seedTurn(sql)
      const b = await seedTurn(sql)
      await beginToolCall(sql, a, 'toolu_1', 'x')
      expect(await beginToolCall(sql, b, 'toolu_1', 'x')).toEqual({ status: 'fresh' })
    })
  })

  it('rejects finishing a call that was never begun', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await expect(finishToolCall(sql, turnId, 'toolu_never_begun', { ok: true }))
        .rejects.toThrow()
    })
  })

  it('replays a stored null result without confusing it for no result', async () => {
    await withTestDb(async (sql) => {
      const turnId = await seedTurn(sql)
      await beginToolCall(sql, turnId, 'toolu_1', 'lookup_availability')
      await finishToolCall(sql, turnId, 'toolu_1', null)
      expect(await beginToolCall(sql, turnId, 'toolu_1', 'lookup_availability'))
        .toEqual({ status: 'replayed', result: null })
    })
  })
})
