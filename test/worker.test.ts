import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type postgres from 'postgres'
import { APIError, APIConnectionError } from '@anthropic-ai/sdk/core/error'
import { RefusalError } from '../src/errors.js'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { submitMessage } from '../src/handler.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { LIMIT_REACHED_MESSAGE } from '../src/limit-message.js'
import { claimTurn, FencedError, MAX_ATTEMPTS } from '../src/repo/turns.js'
import { sweep } from '../src/sweeper.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { workerDeps } from './helpers/worker.js'

const USER = randomUUID()

async function submit(sql: postgres.Sql, message = 'a week in Portugal', key = 'w1') {
  return submitMessage(
    { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
    { userId: USER, conversationId: null, message, idempotencyKey: key },
  )
}

const apiError = (status: number, headers = new Headers()): unknown =>
  APIError.generate(status, { type: 'error', error: { type: 'api_error', message: 'boom' } }, undefined, headers)

describeDb('runTurn', () => {
  it('answers her, parks the conversation, and records what the turn spent', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql)
      await runTurn(workerDeps(sql), r.turnId!)

      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toContain('a week in Portugal')

      const [t] = await sql`select status, spend_usd_micros from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('done')
      expect(BigInt(t!.spend_usd_micros as string)).toBeGreaterThan(0n)
      const [c] = await sql`select status, spend_usd_micros from course.conversations where id = ${r.conversationId}`
      expect(c!.status).toBe('awaiting_user')
      expect(BigInt(c!.spend_usd_micros as string)).toBeGreaterThan(0n)
    })
  })

  it('walks away when another worker already owns the turn', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w2')
      await claimTurn(sql, r.turnId!)                 // somebody got there first
      await runTurn(workerDeps(sql), r.turnId!)        // must not throw
      const msgs = await sql`select role from course.messages where conversation_id = ${r.conversationId}`
      expect(msgs.map((m) => m.role)).toEqual(['user'])
    })
  })

  it('resumes from the transcript rather than starting the conversation over', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Portugal', 'w3')
      const seen: number[] = []
      const agent: Agent = async ({ state }) => {
        seen.push(state.messages.length)
        return { kind: 'message', text: `saw ${state.messages.length} lines`, costMicros: 1_000n }
      }
      await runTurn(workerDeps(sql, agent), r.turnId!)
      // Her message was loaded out of the database, not invented.
      expect(seen).toEqual([1])
    })
  })

  // The deterministic failure a review caught: a stray later press on the
  // SAME conversation, stamped turn_id = null by src/handler.ts's `busy`
  // path, must never be read as part of THIS turn's transcript. An earlier
  // draft of the worker loop scanned the whole conversation and would have
  // answered "and I forgot the crib" against a turn opened for "a week in
  // Portugal"; loadTurnInput's turn-scoped join is what this test pins.
  it('answers the turn she is owed, not a later press on the same conversation', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'a week in Portugal', 'w3b')
      // She types again while this turn is still queued: exactly src/handler.ts's
      // `busy` path, a real row on the SAME conversation with no turn of its own.
      await sql`insert into course.messages (conversation_id, user_id, turn_id, role, content)
                values (${r.conversationId}, ${USER}, null, 'user', 'and I forgot the crib')`
      const agent: Agent = async ({ state }) => {
        const last = [...state.messages].reverse().find((m) => m.role === 'user')
        return { kind: 'message', text: `answering: ${last?.content}`, costMicros: 10n }
      }
      await runTurn(workerDeps(sql, agent), r.turnId!)
      const msgs = await sql`select content from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      expect(msgs[msgs.length - 1]!.content).toBe('answering: a week in Portugal')
    })
  })

  it('does not repeat a completed tool call on resume', async () => {
    await withTestDb(async (sql) => {
      const sideEffect = vi.fn().mockResolvedValue({ ok: true })
      let handedOut = false
      const agent: Agent = async () => {
        if (!handedOut) {
          handedOut = true
          return { kind: 'tool', callId: 'toolu_1', name: 'search_hotels', run: sideEffect, costMicros: 10n }
        }
        return { kind: 'message', text: 'done', costMicros: 10n }
      }

      const r = await submit(sql, 'hi', 'w4')
      await runTurn(workerDeps(sql, agent), r.turnId!)
      expect(sideEffect).toHaveBeenCalledTimes(1)

      // A crash and a resume: reopen the turn and run it again.
      await sql`update course.turns set status = 'queued' where id = ${r.turnId}`
      handedOut = false
      await runTurn(workerDeps(sql, agent), r.turnId!)
      expect(sideEffect).toHaveBeenCalledTimes(1)      // NOT twice
    })
  })

  it('escalates rather than guess when a tool call was started and never finished', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w5')
      const sideEffect = vi.fn().mockResolvedValue({ ok: true })
      const agent: Agent = async () =>
        ({ kind: 'tool', callId: 'toolu_1', name: 'escalate', run: sideEffect, costMicros: 10n })

      // Leave the intent behind with no result, the way a kill mid call does.
      await sql`insert into course.tool_calls (turn_id, call_id, name, status)
                values (${r.turnId}, 'toolu_1', 'escalate', 'pending')`
      await runTurn(workerDeps(sql, agent), r.turnId!)

      expect(sideEffect).not.toHaveBeenCalled()
      const [t] = await sql`select status, fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('failed')
      // Not 'fenced': fenced means another worker holds the claim and is
      // alive to finish the turn, which needs nobody's attention.
      // 'ambiguous_tool_call' is the one outcome that genuinely needs a
      // person (src/repo/toolCalls.ts, src/sweeper.ts's runbook).
      expect(t!.fail_reason).toBe('ambiguous_tool_call')
    })
  })

  // A real step can outlive HEARTBEAT_STALE. Nothing advanced heartbeat_at
  // DURING a step, only after one, so a live worker looked dead mid call and the
  // sweeper handed its turn to somebody else.
  it('keeps beating while a slow step is still in flight', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w6')
      let beatsDuringStep = -1
      const beats = { count: 0 }
      const slow: Agent = async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        beatsDuringStep = beats.count
        return { kind: 'message', text: 'ok', costMicros: 10n }
      }
      const deps = workerDeps(sql, slow)
      deps.heartbeatIntervalMs = 20
      deps.onHeartbeat = () => { beats.count += 1 }
      await runTurn(deps, r.turnId!)
      // Fired WHILE the step was running, not once at the end. Inside
      // withTestDb every now() is the transaction's own timestamp, so reading
      // heartbeat_at could never show this; the count can.
      expect(beatsDuringStep).toBeGreaterThan(0)
    })
  })

  // The global rule this whole file leans on: a heartbeat timer must never
  // outlive the step it covers. The success path above proves the count is
  // non-zero DURING a step; this proves ticking actually STOPS once the step
  // is over, on both the ordinary exit and the throwing one. Real timers, not
  // fake ones: `vi.useFakeTimers()` was tried here first, as the review
  // suggested, but this suite's heartbeat tick makes a REAL Postgres call
  // on every fire, and advancing a fake clock does not wait for that real
  // network round trip to land; the whole scenario either read a stale
  // "0 beats" or hung to the test timeout waiting on a query the fake clock
  // had already raced past. Real, short delays are what the rest of this
  // file already uses for the same reason (see the test just above).
  it('stops ticking once the step settles, on success', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w6b')
      const beats = { count: 0 }
      const agent: Agent = async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return { kind: 'message', text: 'ok', costMicros: 10n }
      }
      const deps = workerDeps(sql, agent)
      deps.heartbeatIntervalMs = 15
      deps.onHeartbeat = () => { beats.count += 1 }
      await runTurn(deps, r.turnId!)
      const beatsAtDone = beats.count
      expect(beatsAtDone).toBeGreaterThan(0)
      // Ten more interval periods' worth of real time: if clearInterval had
      // not run in withHeartbeat's `finally`, this would tick several more
      // times against a turn the run has already finished with.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(beats.count).toBe(beatsAtDone)
    })
  })

  it('stops ticking once the step settles, by throwing', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w6c')
      const beats = { count: 0 }
      const boom = new Error('agent exploded')
      const agent: Agent = async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        throw boom
      }
      const deps = workerDeps(sql, agent)
      deps.heartbeatIntervalMs = 15
      deps.onHeartbeat = () => { beats.count += 1 }
      await expect(runTurn(deps, r.turnId!)).rejects.toThrow('agent exploded')
      const beatsAtThrow = beats.count
      expect(beatsAtThrow).toBeGreaterThan(0)
      // Not "more ticks would be harmless": a timer still running after its
      // step has already failed the turn would keep calling heartbeat()
      // against a row this run no longer has any business touching.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(beats.count).toBe(beatsAtThrow)
    })
  })

  // The subtlest code in the module: a tick's own heartbeat() discovering
  // FencedError does not stop the step in flight (nothing here can cancel a
  // call already running), it aborts the signal and defers the throw until
  // `work()` itself settles. Proved with a real second claim, not a stub, so
  // this exercises withHeartbeat's own deferred re-throw rather than an
  // agent that throws FencedError directly (which never touches a tick at
  // all, and is already covered by 'never classifies a FencedError' below).
  it('re-throws a fence a tick discovers mid-step, leaving the turn to its new owner', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w6d')
      const agent: Agent = async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        return { kind: 'message', text: 'too late', costMicros: 10n }
      }
      const deps = workerDeps(sql, agent)
      deps.heartbeatIntervalMs = 20
      const run = runTurn(deps, r.turnId!)
      // Let the claim's own first heartbeat tick or two pass uneventfully.
      await new Promise((resolve) => setTimeout(resolve, 45))
      // Steal the turn exactly as test/lease.test.ts does: back-date the
      // heartbeat this worker itself refreshed, then claim it for real.
      await sql`update course.turns set heartbeat_at = now() - interval '5 minutes' where id = ${r.turnId}`
      const stolen = await claimTurn(sql, r.turnId!)
      expect(stolen).not.toBeNull()
      // The next tick's heartbeat() no longer matches this worker's
      // attempts and throws FencedError for real; withHeartbeat captures it
      // as the abort signal's reason and re-throws it once the agent's own
      // delay resolves.
      await run                                            // must resolve quietly
      const [t] = await sql`select status, fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('running')                    // the new owner's claim, untouched
      expect(t!.fail_reason).toBeNull()
    })
  })


  // The deadline path. Handing back the lease is not the same as saving state:
  // saveTurnState leaves the row running with a fresh heartbeat, which the
  // re-invocation's own claimTurn can never satisfy.
  it('hands the lease back on continue_later and asks to be re-invoked', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w7')
      const deps = workerDeps(sql)
      deps.deadlineMs = () => Date.now()              // any step blows the deadline
      await runTurn(deps, r.turnId!)

      expect(deps.reinvoke).toHaveBeenCalledWith(r.turnId)
      const [t] = await sql`select status from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('queued')
      expect(await claimTurn(sql, r.turnId!)).not.toBeNull()   // immediately claimable
    })
  })

  // R1 from the fix-round-1 re-review: a retry that would cross the
  // invocation's own remaining budget must not be classified and failed as
  // a provider outage. The work is still retryable and the provider is not
  // the problem; a platform ceiling on THIS invocation is a reason to hand
  // the lease back, exactly like decideNext's own continue_later, not a
  // reason to end the turn.
  it('hands the lease back rather than failing the turn when a retry would cross the budget', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w7b')
      const headers = new Headers({ 'retry-after': '900' })      // fifteen minutes
      let calls = 0
      const agent: Agent = async () => { calls += 1; throw apiError(429, headers) }
      const deps = workerDeps(sql, agent)
      deps.deadlineMs = () => Date.now() + 120_000              // two minutes left
      await runTurn(deps, r.turnId!)

      expect(calls).toBe(1)                                     // gave up rather than sleep past the budget
      expect(deps.reinvoke).toHaveBeenCalledWith(r.turnId)
      const [t] = await sql`select status, state, attempts from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('queued')
      expect(t!.state).toEqual({ step: 0, messages: [{ role: 'user', content: 'hi' }] })
      expect(t!.attempts).toBe(1)                               // continueLater does not bump it itself
      const [c] = await sql`select status from course.conversations where id = ${r.conversationId}`
      expect(c!.status).toBe('working')                         // untouched: no closer ever ran
    })
  })

  it('ends a turn that has no attempt left to continue with', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w8')
      await sql`update course.turns set attempts = ${MAX_ATTEMPTS - 1} where id = ${r.turnId}`
      const deps = workerDeps(sql)
      deps.deadlineMs = () => Date.now()
      await runTurn(deps, r.turnId!)

      expect(deps.reinvoke).not.toHaveBeenCalled()
      const [t] = await sql`select status, fail_reason from course.turns where id = ${r.turnId}`
      // Requeued instead, this turn would be a row nothing can ever claim again,
      // swept forever and never worked.
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('deadline_exceeded')
    })
  })

  it('stops at a ceiling with the same sentence tier 2 writes', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'w9')
      await sql`update course.conversations
                   set spend_usd_micros = ${DEFAULT_LIMITS.conversationCeilingMicros.toString()}
                 where id = ${r.conversationId}`
      await runTurn(workerDeps(sql), r.turnId!)

      const [t] = await sql`select fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.fail_reason).toBe('limit_reached')
      const [c] = await sql`select status from course.conversations where id = ${r.conversationId}`
      expect(c!.status).toBe('limit_reached')
      const msgs = await sql`select content from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      expect(msgs[1]!.content).toBe(LIMIT_REACHED_MESSAGE.conversation)
    })
  })
})

describeDb('runTurn, when the step throws', () => {
  const throwing = (err: unknown): Agent => async () => { throw err }

  it('retries a transient failure before failing the turn', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e1')
      let calls = 0
      const flaky: Agent = async () => {
        calls += 1
        if (calls < 3) throw apiError(429)
        return { kind: 'message', text: 'ok in the end', costMicros: 10n }
      }
      await runTurn(workerDeps(sql, flaky), r.turnId!)
      expect(calls).toBe(3)
      const [t] = await sql`select status from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('done')
    })
  })

  it('records a permanent request fault as provider_rejected, not provider_down', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e2')
      await expect(runTurn(workerDeps(sql, throwing(apiError(400))), r.turnId!)).rejects.toThrow()
      const [t] = await sql`select status, fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('provider_rejected')
    })
  })

  it('records a request that never arrived as fetch_failed', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e3')
      const err = new APIConnectionError({ message: 'socket hang up' })
      await expect(runTurn(workerDeps(sql, throwing(err)), r.turnId!)).rejects.toThrow()
      const [t] = await sql`select fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.fail_reason).toBe('fetch_failed')
    })
  })

  it('records a refusal as refused, and tells her rather than answering emptily', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e4')
      await expect(
        runTurn(workerDeps(sql, throwing(new RefusalError('cyber', 'no'))), r.turnId!),
      ).rejects.toThrow(RefusalError)
      const [t] = await sql`select fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.fail_reason).toBe('refused')
      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${r.conversationId} order by seq`
      // Not an empty bubble, which is what a harness that only inspects
      // exceptions hands her, and not the model's own words either.
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe(TURN_FAILED_MESSAGE)
      expect(msgs[1]!.content).not.toBe('')
    })
  })

  it('records an error it cannot name as unclassified, never as a provider outage', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e5')
      await expect(
        runTurn(workerDeps(sql, throwing(new TypeError('x is not a function'))), r.turnId!),
      ).rejects.toThrow(TypeError)
      const [t] = await sql`select fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.fail_reason).toBe('unclassified')
    })
  })

  // A failed turn is terminal, and the sweeper only ever looks at queued and
  // running rows, so a fault an operator has to fix cannot come back round.
  it('leaves a permanent failure terminal, and the sweeper leaves it alone', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e6')
      await expect(runTurn(workerDeps(sql, throwing(apiError(401))), r.turnId!)).rejects.toThrow()
      await sql`update course.turns set heartbeat_at = now() - interval '10 minutes' where id = ${r.turnId}`
      const out = await sweep(sql)
      expect(out.requeued).not.toContain(r.turnId)
      expect(out.reaped).not.toContain(r.turnId)
    })
  })

  // A superseded worker writes NOTHING. FencedError short-circuits BEFORE the
  // classifier, because stamping a fail reason on a turn we no longer own would
  // overwrite the run that took it over.
  it('never classifies a FencedError', async () => {
    await withTestDb(async (sql) => {
      const r = await submit(sql, 'hi', 'e7')
      await runTurn(workerDeps(sql, throwing(new FencedError(r.turnId!))), r.turnId!)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${r.turnId}`
      expect(t!.status).toBe('running')
      expect(t!.fail_reason).toBeNull()
    })
  })
})
