import { describe, it, expect, vi } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { submitMessage } from '../src/handler.js'
import { runTurn, echoAgent, type Agent, type WorkerDeps } from '../src/worker.js'
import { APIError } from '@anthropic-ai/sdk'
import { claimTurn, FencedError } from '../src/repo/turns.js'
import { RefusalError } from '../src/errors.js'
import { sweep } from '../src/sweeper.js'
import * as turnsRepo from '../src/repo/turns.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { recordSpend } from '../src/repo/spend.js'
import type { TurnState } from '../src/engine.js'

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

  // T0.1: withHeartbeat wraps deps.agent(...) but, before this fix, not
  // step.run() — a slow tool call (a real supplier request in plan 3) could run
  // past HEARTBEAT_STALE with nothing refreshing heartbeat_at in between.
  //
  // NOTE on technique: withTestDb runs the whole test inside one Postgres
  // transaction that is rolled back at the end (test/helpers/db.ts). Postgres
  // freezes now() at transaction start, so every `heartbeat_at = now()` write
  // in this test stores the SAME wall-clock value no matter how many times it
  // runs — a raw before/after read of the column can never show movement here.
  // So, like the existing "emits a heartbeat while a slow step is still in
  // flight" test above, this pins against the heartbeat() CALL COUNT captured
  // the instant run() starts, and asserts it grows while run() is still
  // in flight — not merely that the turn eventually completed.
  it('emits a heartbeat while a slow tool call is still in flight', async () => {
    await withTestDb(async (sql) => {
      const heartbeatSpy = vi.spyOn(turnsRepo, 'heartbeat')
      let callsAtStart = -1
      let callsDuringRun = -1
      let handedOut = false

      const agent: Agent = async () => {
        if (handedOut) return { kind: 'message' as const, text: 'done', costMicros: 10n }
        handedOut = true
        return {
          kind: 'tool' as const,
          callId: 'toolu_slow',
          name: 'slow_tool',
          run: async () => {
            callsAtStart = heartbeatSpy.mock.calls.length
            // Sleep well past several heartbeat intervals so withHeartbeat's
            // timer has room to tick more than once before run() resolves.
            await new Promise((resolve) => setTimeout(resolve, 120))
            callsDuringRun = heartbeatSpy.mock.calls.length
            return { ok: true }
          },
          costMicros: 10n,
        }
      }

      const r = await submit(sql)
      const deps = workerDeps(sql, agent)
      deps.heartbeatIntervalMs = 20
      await runTurn(deps, r.turnId!)

      // Pinned against the call count captured the instant run() started —
      // not merely "the turn completed". Without the fix, step.run() isn't
      // wrapped in withHeartbeat, so no tick fires during the sleep and
      // callsDuringRun === callsAtStart.
      expect(callsAtStart).toBeGreaterThanOrEqual(0)
      expect(callsDuringRun).toBeGreaterThan(callsAtStart)
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

  it('hands the agent the id of the turn it is running', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Faro')
      let seen: string | null = null
      const spy: Agent = async (ctx) => {
        seen = ctx.turnId
        return { kind: 'message', text: 'ok', costMicros: 1_000n }
      }
      await runTurn(workerDeps(sql, spy), r.turnId!)
      // Task 10's driver cannot reach the supplier budget, the model_calls ledger
      // or runGates without this. Before this task the literal above is a TS2353.
      expect(seen).toBe(r.turnId)
    })
  })

  it('does not charge again for spend the agent has already debited', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hello')
      const DEBIT = 250_000n
      // Stands in for Task 10's driver, which reserves and reconciles its own
      // model call. `recordSpend` performs the IDENTICAL conversations
      // increment and daily_usage upsert that Task 4's `reserve` does, and it
      // exists today — so this defect can be pinned here, three tasks before the
      // driver that would have shipped it.
      const selfDebiting: Agent = async (ctx) => {
        await recordSpend(sql, {
          userId: USER, conversationId: ctx.conversationId, costMicros: DEBIT,
        })
        return { kind: 'message', text: 'ok', costMicros: 0n, recordedMicros: DEBIT }
      }
      await runTurn(workerDeps(sql, selfDebiting), r.turnId!)

      const [conv] = await sql<ConversationRow[]>`
        select spend_usd_micros from conversations where id = ${r.conversationId}`
      const [turn] = await sql<TurnRow[]>`
        select spend_usd_micros from turns where id = ${r.turnId}`
      // ONCE. A worker that also called recordSpend(step.costMicros) here would
      // read 500_000n, and every driver model call in production would cost twice
      // what the ledger says it did.
      expect(BigInt(conv!.spend_usd_micros)).toBe(DEBIT)
      // ...and the turn still reports what the turn really spent, so the
      // already-debited micros are not simply dropped.
      expect(BigInt(turn!.spend_usd_micros)).toBe(DEBIT)
    })
  })

  /**
   * The tool path's half of the same invariant, which the `message` and `fail`
   * tests above cannot reach. Two things are pinned here that nothing else pins:
   *
   *  - a tool step's `recordedMicros` reaches `turns.spend_usd_micros`. Delete
   *    the `turnSpend.total += alreadyDebited` line and this test reads 6_000n
   *    instead of 106_000n.
   *  - BOTH fields on ONE step is legitimate, not a mistake. A driver's model
   *    call is self-debited (`recordedMicros`) while the supplier call the tool
   *    then makes is still owed by the worker (`costMicros`) — two different
   *    sets of micros. The rule is that the same micros must never be named
   *    twice, which is why the conversation ledger below must show the
   *    `costMicros` only.
   */
  it('reports a tool step\'s already-debited micros without recharging them', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      let handedOut = false
      const agent: Agent = async () => {
        if (handedOut) {
          return {
            kind: 'message' as const, text: 'done',
            costMicros: 1_000n, recordedMicros: 60_000n,
          }
        }
        handedOut = true
        return {
          kind: 'tool' as const, callId: 'toolu_billed', name: 'explore_flights',
          run: async () => ({ offers: 1 }),
          costMicros: 5_000n,          // the supplier call: the worker still owes it
          recordedMicros: 40_000n,     // the model call: the agent already debited it
        }
      }
      await runTurn(workerDeps(sql, agent), r.turnId!)

      const [turn] = await sql<TurnRow[]>`
        select spend_usd_micros from turns where id = ${r.turnId}`
      const [conv] = await sql<ConversationRow[]>`
        select spend_usd_micros from conversations where id = ${r.conversationId}`
      // Everything the turn cost: 40_000 + 5_000 (tool step) + 60_000 + 1_000.
      expect(BigInt(turn!.spend_usd_micros)).toBe(106_000n)
      // ...but only the micros nobody had debited yet went through recordSpend.
      // 106_000n here would mean every self-debited driver call is billed twice.
      expect(BigInt(conv!.spend_usd_micros)).toBe(6_000n)
    })
  })

  /**
   * Defect 4. `loop()` appended the tool RESULT to the transcript but never the
   * assistant turn that ASKED for the tool. A `tool_result` block with no
   * matching `tool_use` is a 400 from the provider on the very next request, so
   * a multi-step driver would die on its second step — with a transcript that
   * looks perfectly reasonable in the database.
   */
  it('appends the assistant tool_use turn ahead of the matching tool_result', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      let handedOut = false
      const agent: Agent = async () => {
        if (handedOut) return { kind: 'message' as const, text: 'done', costMicros: 10n }
        handedOut = true
        return {
          kind: 'tool' as const,
          callId: 'toolu_pair',
          name: 'explore_flights',
          run: async () => '{"offers":1}',
          costMicros: 10n,
          assistantContent: [
            { type: 'thinking' as const, thinking: 'BER to FAO', signature: 'sig-1' },
            { type: 'tool_use' as const, id: 'toolu_pair', name: 'explore_flights',
              input: { from: 'BER', to: 'FAO' } },
          ],
        }
      }
      await runTurn(workerDeps(sql, agent), r.turnId!)

      const [row] = await sql<{ state: TurnState }[]>`
        select state from turns where id = ${r.turnId}`
      const messages = row!.state.messages
      const useIdx = messages.findIndex(
        (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))
      const resultIdx = messages.findIndex(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
      expect(useIdx).toBeGreaterThanOrEqual(0)
      // ORDER, pinned exactly: the request comes immediately before its answer.
      expect(resultIdx).toBe(useIdx + 1)

      const use = messages[useIdx]!.content.find((b) => b.type === 'tool_use')
      const res = messages[resultIdx]!.content.find((b) => b.type === 'tool_result')
      if (use?.type !== 'tool_use' || res?.type !== 'tool_result') {
        throw new Error('unreachable')
      }
      // ...and the ids PAIR. An unpaired id is the same 400 as a missing turn.
      expect(use.id).toBe('toolu_pair')
      expect(res.tool_use_id).toBe('toolu_pair')
      // The thinking block rides along verbatim, signature included: a thinking
      // block that is not echoed back byte-for-byte is rejected too.
      expect(messages[useIdx]!.content[0]).toEqual(
        { type: 'thinking', thinking: 'BER to FAO', signature: 'sig-1' })
      // run() returned a string, so it is appended verbatim rather than
      // JSON.stringify-d into an escaped string literal.
      expect(res.content).toBe('{"offers":1}')
    })
  })
})

/**
 * T0.2. The crash handler used to write `provider_down` for every error, so a
 * permanent 400 and a transient 429 were recorded identically — and a model
 * refusal, which is an HTTP 200 and never throws at all, had no value to be
 * recorded as. These pin the classifier at the seam where the worker uses it.
 */
describeDb('runTurn error classification', () => {
  const throwing = (err: unknown): Agent => async () => { throw err }

  const apiError = (status: number): unknown =>
    APIError.generate(
      status,
      { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } },
      undefined,
      new Headers(),
    )

  it('records a permanent request fault as provider_rejected, not provider_down', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await expect(runTurn(workerDeps(sql, throwing(apiError(400))), r.turnId!)).rejects.toThrow()

      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('provider_rejected')
    })
  })

  it('records a rate limit as provider_down — the retryable one', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await expect(runTurn(workerDeps(sql, throwing(apiError(429))), r.turnId!)).rejects.toThrow()
      const [turn] = await sql<TurnRow[]>`select fail_reason, status, spend_usd_micros from turns where id = ${r.turnId}`
      expect(turn!.fail_reason).toBe('provider_down')
    })
  })

  it('records a model refusal as refused, and writes no agent message', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await expect(
        runTurn(workerDeps(sql, throwing(new RefusalError('cyber', 'no'))), r.turnId!),
      ).rejects.toThrow(RefusalError)

      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      const msgs = await sql<MessageRow[]>`
        select role from messages where conversation_id = ${r.conversationId}`
      expect(turn!.fail_reason).toBe('refused')
      // The failure the old code would have read as "a successful turn that
      // produced no content": the user must not be handed an empty answer.
      expect(msgs.map((m) => m.role)).toEqual(['user'])
    })
  })

  it('records an error it cannot name as unclassified, never provider_down', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await expect(
        runTurn(workerDeps(sql, throwing(new Error('x is not a function'))), r.turnId!),
      ).rejects.toThrow()
      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      expect(turn!.fail_reason).toBe('unclassified')
    })
  })

  /**
   * Requirement 2 of the brief: a non-retryable failure must not sit in a state
   * the sweeper will requeue until it reaps the turn as a crash loop. The
   * heartbeat is pushed well past HEARTBEAT_STALE first, so the turn would be
   * swept if `status` were anything the sweeper looks at.
   */
  it('leaves a non-retryable failure terminal — the sweeper will not requeue it', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await expect(runTurn(workerDeps(sql, throwing(apiError(401))), r.turnId!)).rejects.toThrow()

      await sql`update turns set heartbeat_at = now() - interval '10 minutes'
                 where id = ${r.turnId}`
      const out = await sweep(sql, {})
      expect(out.requeued).not.toContain(r.turnId)
      expect(out.reaped).not.toContain(r.turnId)

      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('provider_rejected')
    })
  })

  /**
   * A fenced worker writes NOTHING. FencedError must short-circuit BEFORE the
   * classifier: classifying it would write a fail_reason for a turn this worker
   * no longer owns, stamping `failed` over the run that superseded it.
   */
  it('never classifies a FencedError — a superseded worker writes nothing', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await runTurn(workerDeps(sql, throwing(new FencedError(r.turnId!))), r.turnId!)

      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      expect(turn!.status).toBe('running')
      expect(turn!.fail_reason).toBeNull()
    })
  })

  /**
   * The `fail` AgentStep — spec section 8's refused driver call. A refusal is an
   * HTTP 200 that never throws, so it cannot reach the crash handler above; and
   * parking it would write status 'done' with fail_reason null, making a refusal
   * indistinguishable from a normal question. This step is what finally gives
   * `refused` (src/engine.ts) a writer on the non-throwing path, and it must end
   * the turn NAMED *and* leave her words she can act on.
   */
  it('records a fail step as a named failure, with words she can act on', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      const refusing: Agent = async () => ({
        kind: 'fail',
        reason: 'refused',
        message: 'I cannot help with that. Try asking about flights or hotels.',
        recordedMicros: 7_000n,
      })
      // Returns normally: a refusal is a recorded outcome, not a crash.
      await runTurn(workerDeps(sql, refusing), r.turnId!)

      const [turn] = await sql<TurnRow[]>`select * from turns where id = ${r.turnId}`
      const [convo] = await sql<ConversationRow[]>`
        select * from conversations where id = ${r.conversationId}`
      const msgs = await sql<MessageRow[]>`
        select role, content from messages
         where conversation_id = ${r.conversationId} order by created_at`

      expect(turn!.status).toBe('failed')
      expect(turn!.fail_reason).toBe('refused')
      expect(convo!.status).toBe('failed')
      // Not a blank thread: the message is written inside failTurn's own fenced
      // transaction, so it can never land on a turn we no longer own.
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toContain('Try asking about flights or hotels')
      // The micros the agent already debited are reported on the turn...
      expect(BigInt(turn!.spend_usd_micros)).toBe(7_000n)
      // ...and are NOT charged to the conversation a second time. This agent
      // called recordSpend never, so a fail path that did would read 7_000n.
      expect(BigInt(convo!.spend_usd_micros)).toBe(0n)
    })
  })
})
