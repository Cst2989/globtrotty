import { describe, it, expect } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { claimTurn, heartbeat, completeTurn, failTurn, FencedError } from '../src/repo/turns.js'

const USER = '11111111-1111-1111-1111-111111111111'
const EMPTY = { step: 0, messages: [] }

async function seed(sql: postgres.Sql) {
  const [c] = await sql`insert into conversations (user_id) values (${USER}) returning *`
  const [t] = await sql`insert into turns (conversation_id, user_id, idempotency_key)
                        values (${c!.id}, ${USER}, 'k') returning *`
  return { c: c!, t: t! }
}

describeDb('completeTurn', () => {
  it('writes the message, the status, and the turn spend atomically', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: 'Two options for Faro.',
        parked: true, spendMicros: 1_250n,
      })

      const [turn] = await sql`select * from turns where id = ${t.id}`
      const [convo] = await sql`select * from conversations where id = ${c.id}`
      const msgs = await sql`select * from messages where conversation_id = ${c.id}`

      expect(turn!.status).toBe('done')            // parking is TERMINAL for the turn
      expect(turn!.finished_at).not.toBeNull()
      expect(turn!.spend_usd_micros).toBe('1250')  // completeTurn writes TURN-level spend only
      expect(convo!.status).toBe('awaiting_user')
      expect(convo!.spend_usd_micros).toBe('0')    // conversation spend is recordSpend's job (Task 8)
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.turn_id).toBe(t.id)
    })
  })

  it('leaves the conversation active when the turn is not parking', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await completeTurn(sql, claim, {
        state: EMPTY, agentMessage: null, parked: false, spendMicros: 0n,
      })
      const [convo] = await sql`select status from conversations where id = ${c.id}`
      expect(convo!.status).toBe('active')
    })
  })

  it('refuses to complete when fenced, and changes nothing', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      await claimTurn(sql, t.id)

      await expect(
        completeTurn(sql, first, {
          state: EMPTY, agentMessage: 'stale', parked: true, spendMicros: 99n,
        }),
      ).rejects.toThrow(FencedError)

      const msgs = await sql`select * from messages where conversation_id = ${c.id}`
      const [turn] = await sql`select spend_usd_micros from turns where id = ${t.id}`
      const [convo] = await sql`select * from conversations where id = ${c.id}`
      expect(msgs).toHaveLength(0)               // no partial write survived
      expect(turn!.spend_usd_micros).toBe('0')
      expect(convo!.spend_usd_micros).toBe('0')
      expect(convo!.status).toBe('active')        // the conversation-status write never ran either
    })
  })

  // The fenced test above throws on the FIRST statement (the fencing UPDATE itself),
  // so it can't tell a real transaction apart from an unbatched sequence of writes —
  // an unbatched version would pass it too. Force the failure on a LATER statement
  // instead: a live, correctly-fenced claim whose userId doesn't match the seeded
  // conversation's owner. The turns UPDATE (keyed on id/attempts/status only) still
  // matches and sets status='done', then the messages insert violates the composite
  // FK (conversation_id, user_id) -> conversations(id, user_id) and throws. Only a
  // real transaction rolls the turns UPDATE back with it.
  it('rolls back an earlier write when a later write fails, leaving the turn running', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      const mismatched = { ...claim, userId: '22222222-2222-2222-2222-222222222222' }

      await expect(
        completeTurn(sql, mismatched, {
          state: EMPTY, agentMessage: 'will not survive', parked: true, spendMicros: 500n,
        }),
      ).rejects.toThrow()

      const [turn] = await sql`select status, spend_usd_micros from turns where id = ${t.id}`
      const msgs = await sql`select * from messages where conversation_id = ${c.id}`
      const [convo] = await sql`select status from conversations where id = ${c.id}`

      expect(turn!.status).toBe('running')  // fails against an unbatched implementation
      expect(turn!.spend_usd_micros).toBe('0')
      expect(msgs).toHaveLength(0)
      expect(convo!.status).toBe('active')
    })
  })
})

describeDb('failTurn', () => {
  it('records the reason, the accumulated spend, and surfaces failed on the conversation', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await failTurn(sql, claim, 'provider_down', 4_200n)
      const [turn] = await sql`select * from turns where id = ${t.id}`
      const [convo] = await sql`select status from conversations where id = ${c.id}`
      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('provider_down')
      expect(turn!.spend_usd_micros).toBe('4200')
      expect(convo!.status).toBe('failed')
    })
  })

  // IMPORTANT 3: submitMessage (src/handler.ts) sets 'limit_reached' on the
  // conversation for the exact same condition hit pre-turn. Hitting the ceiling
  // one step into a turn must read the same way, not as "something broke".
  it('surfaces limit_reached, not failed, on the conversation when the reason is a ceiling', async () => {
    await withTestDb(async (sql) => {
      const { c, t } = await seed(sql)
      const claim = (await claimTurn(sql, t.id))!
      await failTurn(sql, claim, 'limit_reached', 0n)
      const [turn] = await sql`select fail_reason from turns where id = ${t.id}`
      const [convo] = await sql`select status from conversations where id = ${c.id}`
      expect(turn!.fail_reason).toBe('limit_reached')
      expect(convo!.status).toBe('limit_reached')
    })
  })

  it('refuses to fail when fenced, and changes nothing', async () => {
    await withTestDb(async (sql) => {
      const { t } = await seed(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      await claimTurn(sql, t.id)

      await expect(failTurn(sql, first, 'provider_down', 0n)).rejects.toThrow(FencedError)

      const [turn] = await sql`select status from turns where id = ${t.id}`
      expect(turn!.status).toBe('running')
    })
  })
})

describeDb('heartbeat', () => {
  it('rejects a fenced claim while the live claim succeeds', async () => {
    await withTestDb(async (sql) => {
      const { t } = await seed(sql)
      const first = (await claimTurn(sql, t.id))!
      await sql`update turns set heartbeat_at = now() - interval '5 minutes' where id = ${t.id}`
      const second = (await claimTurn(sql, t.id))!

      await expect(heartbeat(sql, first)).rejects.toThrow(FencedError)
      await expect(heartbeat(sql, second)).resolves.toBeUndefined()

      const [row] = await sql`select attempts from turns where id = ${t.id}`
      expect(row!.attempts).toBe(2)
    })
  })
})
