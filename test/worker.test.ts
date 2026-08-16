import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { runTurn, echoAgent, type Agent, type WorkerDeps } from '../src/worker.js'
import { claimTurn } from '../src/repo/turns.js'
import * as turnsRepo from '../src/repo/turns.js'
import { DEFAULT_LIMITS } from '../src/limits.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = DEFAULT_LIMITS

const workerDeps = (sql: postgres.Sql, agent: Agent = echoAgent): WorkerDeps => ({
  sql, limits: LIMITS, agent,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: vi.fn().mockResolvedValue(undefined),
})

async function submit(sql: postgres.Sql, message = 'hello') {
  return submitMessage(
    { sql, limits: LIMITS, invoke: async () => {} },
    { userId: USER, conversationId: null, message, idempotencyKey: 'i1' },
  )
}

type MessageRow = { role: string; content: string }
type ConversationRow = { status: string; spend_usd_micros: string }
type TurnRow = { status: string; fail_reason: string | null; spend_usd_micros: string }

describeDb('runTurn end to end', () => {
  it('produces an agent reply and parks the conversation', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Portugal')
      await runTurn(workerDeps(sql), r.turnId!)

      const msgs = await sql<MessageRow[]>`select * from messages
                              where conversation_id = ${r.conversationId} order by created_at`
      const [convo] = await sql<ConversationRow[]>`select * from conversations where id = ${r.conversationId}`
      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`

      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toContain('a week in Portugal')
      expect(convo!.status).toBe('awaiting_user')
      expect(turn!.status).toBe('done')
      expect(BigInt(convo!.spend_usd_micros)).toBeGreaterThan(0n)
      // IMPORTANT 2: turns.spend_usd_micros used to be hard-coded to 0 on every row.
      expect(BigInt(turn!.spend_usd_micros)).toBeGreaterThan(0n)
    })
  })

  it('walks away when another worker owns the turn', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await claimTurn(sql, r.turnId!)                  // someone else got there first
      await runTurn(workerDeps(sql), r.turnId!)         // must not throw
      const msgs = await sql<MessageRow[]>`select * from messages where conversation_id = ${r.conversationId}`
      expect(msgs).toHaveLength(1)                      // no agent reply written
    })
  })

  it('does not repeat a completed tool call on resume', async () => {
    await withTestDb(async (sql) => {
      const sideEffect = vi.fn().mockResolvedValue({ ok: true })
      let handedOut = false
      const agent: Agent = async () => {
        if (!handedOut) {
          handedOut = true
          return {
            kind: 'tool' as const, callId: 'toolu_1', name: 'escalate_to_human',
            run: sideEffect, costMicros: 10n,
          }
        }
        return { kind: 'message' as const, text: 'done', costMicros: 10n }
      }

      const r = await submit(sql)
      await runTurn(workerDeps(sql, agent), r.turnId!)
      expect(sideEffect).toHaveBeenCalledTimes(1)

      // Simulate a crash-and-resume: reopen the turn and run it again.
      await sql`update turns set status='running', heartbeat_at = now() - interval '5 minutes'
                 where id = ${r.turnId}`
      handedOut = false
      await runTurn(workerDeps(sql, agent), r.turnId!)
      expect(sideEffect).toHaveBeenCalledTimes(1)       // NOT twice
    })
  })

  // CRITICAL 1: a real step (a dozen model calls, a 60s Retry-After sleep) can run
  // well past HEARTBEAT_STALE (90s). Nothing advanced heartbeat_at DURING a step —
  // only saveTurnState, AFTER — so a live worker looked dead to the sweeper mid-call.
  it('emits a heartbeat while a slow step is still in flight', async () => {
    await withTestDb(async (sql) => {
      const heartbeatSpy = vi.spyOn(turnsRepo, 'heartbeat')
      let ticksSeenDuringStep = -1
      const slow: Agent = async () => {
        // Sleep well past several heartbeat intervals so the timer has room to fire
        // more than once before the step resolves.
        await new Promise((resolve) => setTimeout(resolve, 120))
        ticksSeenDuringStep = heartbeatSpy.mock.calls.length
        return { kind: 'message' as const, text: 'ok', costMicros: 10n }
      }

      const r = await submit(sql)
      const deps = workerDeps(sql, slow)
      deps.heartbeatIntervalMs = 20
      await runTurn(deps, r.turnId!)

      // Proves the tick fired WHILE the agent call was still in flight, not just
      // once at the end — the property that did not hold before this fix.
      expect(ticksSeenDuringStep).toBeGreaterThan(0)

      const [turn] = await sql<{ heartbeat_at: Date }[]>`
        select heartbeat_at from turns where id = ${r.turnId}`
      expect(turn!.heartbeat_at).not.toBeNull()
    })
  })

  // CRITICAL 2 end to end: continue_later must release ownership (status -> 'queued'),
  // not just persist state, or the re-invocation's own claimTurn can never claim it.
  it('leaves a continue_later turn immediately claimable by the re-invocation', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      const deps = workerDeps(sql)
      deps.deadlineMs = () => Date.now()   // any step blows the deadline -> continue_later
      await runTurn(deps, r.turnId!)

      expect(deps.reinvoke).toHaveBeenCalledWith(r.turnId)

      const [turn] = await sql<TurnRow[]>`select status from turns where id = ${r.turnId}`
      expect(turn!.status).toBe('queued')

      const reclaimed = await claimTurn(sql, r.turnId!)
      expect(reclaimed).not.toBeNull()
    })
  })

  it('stops and records limit_reached when the ceiling is hit mid-turn', async () => {
    await withTestDb(async (sql) => {
      const greedy: Agent = async () => ({
        // never actually spent — decideNext stops before the agent is invoked once the
        // conversation ceiling below is already met
        kind: 'message' as const, text: 'x', costMicros: LIMITS.conversationCeilingMicros + 1_000_000n,
      })
      const r = await submit(sql)
      await sql`update conversations set spend_usd_micros = ${LIMITS.conversationCeilingMicros.toString()}
                 where id = ${r.conversationId}`
      await runTurn(workerDeps(sql, greedy), r.turnId!)
      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      const [convo] = await sql<ConversationRow[]>`select * from conversations where id = ${r.conversationId}`
      expect(turn!.fail_reason).toBe('limit_reached')
      // IMPORTANT 3: a spend ceiling must not render as "something broke" — the
      // conversation status has to match what submitMessage sets for the same
      // condition pre-turn.
      expect(convo!.status).toBe('limit_reached')
    })
  })
})
