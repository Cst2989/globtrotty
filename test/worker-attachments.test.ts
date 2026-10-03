import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { runTurn, type Agent, type WorkerDeps } from '../src/worker.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LogNotifier, type Notifier } from '../src/notify.js'
import type { ResultsContent } from '../src/results.js'

const USER = '11111111-1111-1111-1111-111111111111'
const LIMITS = DEFAULT_LIMITS

const workerDeps = (
  sql: postgres.Sql, agent: Agent, notifier: Notifier = new LogNotifier(() => {}),
): WorkerDeps => ({
  sql, limits: LIMITS, agent, notifier,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: vi.fn().mockResolvedValue(undefined),
})

async function submit(
  sql: postgres.Sql, conversationId: string | null, message: string, idempotencyKey: string,
) {
  return submitMessage(
    { sql, limits: LIMITS, invoke: async () => {} },
    { userId: USER, conversationId, message, idempotencyKey },
  )
}

type MessageRow = { role: string; content: string }

const RESULTS: ResultsContent = {
  kind: 'flights',
  query: { from: 'BCN', to: 'TYO', outbound: '2026-11-19', inbound: '2026-12-06', adults: 2 },
  sourceIds: ['kiwi:a', 'kiwi:b'],
  assumptions: [],
}

describeDb('worker: step attachments', () => {
  it('writes a results attachment after the agent message row, in created_at order, '
    + 'and the next turn hydrates it as a system message', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, null, 'flights to tokyo', 'i1')

      const stub: Agent = async () => ({
        kind: 'message',
        text: 'Here is what the office found.',
        costMicros: 1_000n,
        attachments: [{ role: 'results', content: RESULTS }],
      })
      await runTurn(workerDeps(sql, stub), r.turnId!)

      // Only the rows this turn itself wrote — the user's own message (above
      // it in the thread) carries no turn_id.
      const turnMsgs = await sql<MessageRow[]>`
        select role, content from messages
         where turn_id = ${r.turnId} order by created_at`
      expect(turnMsgs.map((m) => m.role)).toEqual(['agent', 'results'])
      expect(JSON.parse(turnMsgs[1]!.content)).toEqual(RESULTS)

      const allMsgs = await sql<MessageRow[]>`
        select role, content from messages
         where conversation_id = ${r.conversationId} order by created_at`
      expect(allMsgs.map((m) => m.role)).toEqual(['user', 'agent', 'results'])

      // A fresh turn with no saved state re-hydrates the full transcript from
      // `messages`, including the `results` row, as a `system` message whose
      // text carries the (masked) source ids.
      const r2 = await submit(sql, r.conversationId, 'anything else?', 'i2')
      let sawIds = false
      const spy: Agent = async (ctx) => {
        sawIds = ctx.state.messages.some((m) => m.role === 'system'
          && m.content.some((b) => b.type === 'text' && b.text.includes('kiwi:a') && b.text.includes('kiwi:b')))
        return { kind: 'park', message: 'noted', costMicros: 1_000n }
      }
      await runTurn(workerDeps(sql, spy), r2.turnId!)
      expect(sawIds).toBe(true)
    })
  })
})
