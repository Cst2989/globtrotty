import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { money } from '../src/money.js'
import { submitMessage } from '../src/handler.js'
import { recordLinkClicks } from '../src/repo/linkClicks.js'
import { recordProposal } from '../src/repo/proposals.js'
import { MAX_ATTEMPTS } from '../src/repo/turns.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { sweep } from '../src/sweeper.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'
import { workerDeps } from './helpers/worker.js'

const USER = randomUUID()

/** A turn with a proposal and one emitted link, which is the state rule 6 is about. */
async function turnWithALink(
  sql: postgres.Sql, userId: string, key: string,
  over: { verified?: boolean; quotedAt?: Date } = {},
) {
  const submitted = await submitMessage(handlerDeps(sql), {
    userId, conversationId: null, message: 'book it', idempotencyKey: key,
  })
  const turnId = submitted.turnId!
  const proposalId = await recordProposal(sql, {
    conversationId: submitted.conversationId, userId, turnId,
    refs: [{ sourceId: 'hotel-0-1', quantity: 1, slot: 'stay' }],
  })
  const id = randomUUID()
  await recordLinkClicks(sql, {
    proposalId, turnId, userId,
    verified: over.verified ?? true,
    quotedAt: over.quotedAt ?? new Date(),
    links: [{ id, sourceId: 'hotel-0-1', supplier: 'mock', trackingRef: id,
              url: `https://example.invalid/book/hotel-0-1?subid=${id}`, quoted: money(72_100n, 'EUR') }],
  })
  return { ...submitted, turnId, proposalId }
}

describeDb('after a link is emitted, the worker', () => {
  it('completes the turn with the link message instead of failing it', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-1')
      // An agent that emits and then dies, which is the whole case: the links
      // are already out and the process is not going to finish the turn
      // normally.
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      // runTurn still re-throws, exactly as it does on every other error: the
      // change is what it WRITES before it does, not whether it propagates.
      // Tier 3's own catch is what turns this into a 200 (see
      // netlify/functions/run-turn-background.mts).
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId))
        .rejects.toThrow(/killed after emitting/)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      // Not 'failed'. She is on a supplier's checkout page and a system that
      // tells her the request failed is describing a world she is not in.
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBeNull()

      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent' order by seq`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toContain('example.invalid/book/hotel-0-1')
      expect(msgs[0]!.content).not.toBe(TURN_FAILED_MESSAGE)
    })
  })

  it('still fails a turn that emitted nothing', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'plan it', idempotencyKey: 'ponr-2',
      })
      const dying: Agent = async () => { throw new Error('killed before emitting') }
      // The pre-existing behaviour, unchanged, and worth pinning here: the new
      // branch must be reachable ONLY through a link_clicks row.
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId!)).rejects.toThrow(/killed/)
      const [t] = await sql`select status from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs[0]!.content).toBe(TURN_FAILED_MESSAGE)
    })
  })

  it('states the price\'s real age, from the row, and not "just now"', async () => {
    await withTestDb(async (sql) => {
      // An unverified hand-off: the copy is disclosure, so it renders the age,
      // and the age is the one thing the recovery cannot recompute. Reading it
      // off course.link_clicks.quoted_at is why that column exists.
      const submitted = await turnWithALink(sql, USER, 'ponr-5', {
        verified: false, quotedAt: new Date(Date.now() - 4 * 3_600_000),
      })
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      await expect(runTurn({ ...workerDeps(sql, dying) }, submitted.turnId))
        .rejects.toThrow(/killed after emitting/)

      const [m] = await sql`select content from course.messages
                             where turn_id = ${submitted.turnId} and role = 'agent'`
      // Telling her a four-hour-old price was current is the same untrue
      // reassurance the naive re-quote gives, arrived at from the other end.
      expect(m!.content).toContain('4 hours ago')
      expect(m!.content).not.toContain('just now')
    })
  })
})

/**
 * The four ways `loop` ends a turn `failed` without ever throwing, so none of
 * them reaches `runTurn`'s catch. The catch was the only reader of
 * `course.link_clicks` until this fix round, which meant the rule held for a
 * crash and not for an ordinary refusal: the model asks for the hand-off, gets
 * two live booking URLs, and the NEXT model call in `turn()`'s own tool loop
 * returns `provider_down`, at which point tier 3's driver
 * (netlify/functions/run-turn-background.mts) maps that to a `fail` step and the
 * turn she is in the middle of paying for is marked failed.
 *
 * One helper, `failTurnUnlessLinkEmitted` (src/worker.ts), so there is one copy
 * of the check and a fifth exit added tomorrow has to go through it.
 */
describeDb('after a link is emitted, no exit from the loop fails the turn', () => {
  /** What every case below asserts: `done`, no reason, and her own links back. */
  async function expectHandedOff(sql: postgres.Sql, turnId: string) {
    const [t] = await sql`select status, fail_reason from course.turns where id = ${turnId}`
    expect(t!.status).toBe('done')
    expect(t!.fail_reason).toBeNull()
    const msgs = await sql`select content from course.messages
                            where turn_id = ${turnId} and role = 'agent' order by seq`
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toContain('example.invalid/book/hotel-0-1')
    expect(msgs[0]!.content).not.toBe(TURN_FAILED_MESSAGE)
  }

  it('does not fail it at the step cap', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-6')
      // `decideNext` stops before the agent is called at all, which is the one
      // exit that can fire on a turn that has already done its work: a resumed
      // turn arrives with `state.step` past the cap.
      const never: Agent = async () => { throw new Error('the agent must not be called') }
      const deps = { ...workerDeps(sql, never), limits: { ...DEFAULT_LIMITS, maxSteps: 0 } }
      await runTurn(deps, submitted.turnId)
      await expectHandedOff(sql, submitted.turnId)
    })
  })

  it('does not fail it when the agent itself reports a failure', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-7')
      // The reachable one. `turn()` emitted the links through the cashier and
      // then lost the provider on its next model call; the driver classifies
      // that and returns a `fail` step, with whatever partial text it has.
      const failing: Agent = async () => ({
        kind: 'fail', reason: 'provider_down', text: 'I could not finish that.', costMicros: 0n,
      })
      await runTurn(workerDeps(sql, failing), submitted.turnId)
      await expectHandedOff(sql, submitted.turnId)
    })
  })

  it('does not fail it when a tool call comes back ambiguous', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-8')
      // Started and never finished (lesson 3.4): the pending row is already
      // there when this attempt begins.
      await sql`insert into course.tool_calls (turn_id, call_id, name, status)
                values (${submitted.turnId}, 'call-1', 'search_flights', 'pending')`
      const tooling: Agent = async () => ({
        kind: 'tool', callId: 'call-1', name: 'search_flights',
        run: async () => { throw new Error('the tool must not be run') }, costMicros: 0n,
      })
      await runTurn(workerDeps(sql, tooling), submitted.turnId)
      await expectHandedOff(sql, submitted.turnId)
      // The operator step lesson 3.4 wrote down is unchanged: the pending row
      // stays, and it is still what somebody reads.
      const [row] = await sql`select status from course.tool_calls
                               where turn_id = ${submitted.turnId} and call_id = 'call-1'`
      expect(row!.status).toBe('pending')
    })
  })

  it('does not fail it when the last attempt hands back', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-9')
      // One attempt short of the cap, so this run's claim IS the cap:
      // `continueLater` has no attempt left to hand the turn back with and
      // ends it `deadline_exceeded` instead.
      await sql`update course.turns set attempts = ${MAX_ATTEMPTS - 1} where id = ${submitted.turnId}`
      const handingBack: Agent = async () => ({ kind: 'continue_later', costMicros: 0n })
      const deps = workerDeps(sql, handingBack)
      await runTurn(deps, submitted.turnId)
      await expectHandedOff(sql, submitted.turnId)
      expect(deps.reinvoke).not.toHaveBeenCalled()
    })
  })
})

describeDb('a turn that handed off twice', () => {
  /**
   * `emittedLinks` is scoped to a TURN, and a turn can hand off more than once:
   * one proposal against a supplier that could re-quote, another against one
   * that could not. Taking `verified` and the age off the first row then writes
   * "We checked every price again just now" over the second set's unchecked,
   * hours-old prices, which is the untrue reassurance this whole lesson exists
   * to refuse, produced by the recovery it built.
   */
  it('is described by its stalest, least verified hand-off', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-10')
      const second = randomUUID()
      const proposalId = await recordProposal(sql, {
        conversationId: submitted.conversationId, userId: USER, turnId: submitted.turnId,
        refs: [{ sourceId: 'hotel-0-2', quantity: 1, slot: 'stay' }],
      })
      await recordLinkClicks(sql, {
        proposalId, turnId: submitted.turnId, userId: USER,
        verified: false, quotedAt: new Date(Date.now() - 4 * 3_600_000),
        links: [{ id: second, sourceId: 'hotel-0-2', supplier: 'mock', trackingRef: second,
                  url: `https://example.invalid/book/hotel-0-2?subid=${second}`,
                  quoted: money(31_900n, 'EUR') }],
      })
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      await expect(runTurn(workerDeps(sql, dying), submitted.turnId))
        .rejects.toThrow(/killed after emitting/)

      const [m] = await sql`select content from course.messages
                             where turn_id = ${submitted.turnId} and role = 'agent'`
      // Verified only if every row is, and the age of the stalest number in
      // the set, which is the same choice the cashier makes for one hand-off.
      expect(m!.content).not.toMatch(/checked|verified|confirmed/i)
      expect(m!.content).toContain('4 hours ago')
      expect(m!.content).toContain('hotel-0-1')
      expect(m!.content).toContain('hotel-0-2')
    })
  })

  /**
   * Two hand-offs in two currencies. `handOffMessage` sums them and `sumMoney`
   * throws `CurrencyMismatchError` rather than inventing a currency, which is
   * correct; what must not happen is that throw replacing the error the turn
   * actually died of, which is what building the message inside
   * `completeTurn`'s argument list did.
   */
  it('still propagates the original error when the set cannot be totalled', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-11')
      const second = randomUUID()
      const proposalId = await recordProposal(sql, {
        conversationId: submitted.conversationId, userId: USER, turnId: submitted.turnId,
        refs: [{ sourceId: 'hotel-0-3', quantity: 1, slot: 'stay' }],
      })
      await recordLinkClicks(sql, {
        proposalId, turnId: submitted.turnId, userId: USER, verified: true, quotedAt: new Date(),
        links: [{ id: second, sourceId: 'hotel-0-3', supplier: 'mock', trackingRef: second,
                  url: `https://example.invalid/book/hotel-0-3?subid=${second}`,
                  quoted: money(40_000n, 'USD') }],
      })
      const dying: Agent = async () => { throw new Error('killed after emitting') }
      await expect(runTurn(workerDeps(sql, dying), submitted.turnId))
        .rejects.toThrow(/killed after emitting/)
      // Not CurrencyMismatchError: the reason the turn died is the one that
      // reaches the log, and no message is written, because there is no
      // sentence to write. The turn is left `running` for the sweeper, which
      // reaches the same wall through the same helper, logs it and leaves the
      // row rather than failing it; that is the one turn the crash arm can
      // leave alive-looking, and README.md names it.
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs).toHaveLength(0)
    })
  })
})

/**
 * `withTestDb`, not `withRealDb`, and that is the finding rather than a style
 * choice. These two cases are about what the sweeper DECIDES, not about
 * concurrency, and `sweep()` is global by design: its reap selects
 * `for update skip locked` over every committed row in the database. Committed
 * by `withRealDb`, this file's turns were visible to `test/sweeper.test.ts`
 * running in a parallel worker, which locked or reaped them first, and the
 * assertion below then saw a turn some other file's transaction had taken and
 * rolled back. That is the flake the ledger recorded at 58e2e82, and rerunning
 * this file alone is exactly the condition under which it cannot happen.
 *
 * Rolled back, these rows are invisible to every other worker, and `sweep()`
 * runs on this transaction's own handle. The assertions are scoped to this
 * file's own turn for the other direction of the same problem: this sweep sees
 * everybody else's committed rows, so a count of what it reaped globally is a
 * test that fails on a machine where somebody ran `npm run demo`.
 */
describeDb('after a link is emitted, the sweeper', () => {
  /**
   * The whole-branch review's B10. Rule 6 says nothing may tell her the turn
   * failed after a link went out, and until this fix round the sweeper marked
   * such a turn `failed` with `crash_loop` and only stayed QUIET about it,
   * which is a weaker promise than the rule states and than
   * `src/worker.ts` keeps two files away. A module 5 reader partitioning
   * `course.turns` by `fail_reason` would file a turn that emitted two live
   * booking links as a failure with no links.
   *
   * It now goes through the same `completeIfLinkEmitted` the worker's five
   * failing exits go through, so she gets the hand-off sentence rebuilt from
   * her own `course.link_clicks` rows rather than silence, and the operator
   * step that used to be the only way she ever heard about them is closed for
   * this arm.
   */
  it('completes a crash-looped turn that emitted a link, and never fails it', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-3')
      // Out of attempts and silent: the crash-loop arm's exact condition.
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'running',
                       heartbeat_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      const result = await sweep(sql)
      // Scoped to this turn, never to a global count: sweep() is global and
      // this transaction sees every committed row in the database.
      expect(result.reaped).not.toContain(submitted.turnId)
      expect(result.requeued).not.toContain(submitted.turnId)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBeNull()

      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent' order by seq`
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.content).toContain('example.invalid/book/hotel-0-1')
      expect(msgs[0]!.content).not.toBe(TURN_FAILED_MESSAGE)
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('awaiting_user')
    })
  })

  /**
   * The same case one sweep later. A turn already `done` sits outside both arms
   * of `stale`, so the second walk cannot close it twice, write her a second
   * sentence, or hand the conversation back again.
   */
  it('leaves a turn it has already completed alone', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-3b')
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'running',
                       heartbeat_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      await sweep(sql)
      await sweep(sql)
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs).toHaveLength(1)
      const [t] = await sql`select status from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
    })
  })

  /**
   * The requeue path a turn actually reaches MAX_ATTEMPTS by: the sweeper hands
   * it back, `claimTurn` refuses it at the cap, and it sits `queued` for ever.
   * `completeTurn`'s own fence matches `status = 'running'` and would have
   * skipped exactly this row, which is why the sweeper closes through
   * `completeReapedTurn` (src/repo/turns.ts) instead.
   */
  it('completes a queued turn at the cap that emitted a link', async () => {
    await withTestDb(async (sql) => {
      const submitted = await turnWithALink(sql, USER, 'ponr-3c')
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'queued',
                       queued_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      await sweep(sql)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('done')
      expect(t!.fail_reason).toBeNull()
    })
  })

  it('still tells her when a crash-looped turn emitted nothing', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(handlerDeps(sql), {
        userId: USER, conversationId: null, message: 'plan it', idempotencyKey: 'ponr-4',
      })
      await sql`update course.turns
                   set attempts = ${MAX_ATTEMPTS}, status = 'running',
                       heartbeat_at = now() - interval '10 minutes'
                 where id = ${submitted.turnId}`
      const result = await sweep(sql)
      expect(result.reaped).toContain(submitted.turnId!)
      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')
      expect(t!.fail_reason).toBe('crash_loop')
      const msgs = await sql`select content from course.messages
                              where turn_id = ${submitted.turnId} and role = 'agent'`
      expect(msgs[0]!.content).toBe(TURN_FAILED_MESSAGE)
      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('failed')
    })
  })
})
