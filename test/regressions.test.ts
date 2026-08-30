import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type postgres from 'postgres'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_USER } from '../src/her.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { SpendUnconfirmedError } from '../src/repo/spend.js'
import { runTurn, type Agent, type WorkerDeps } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'

/** Every .ts file under test/, fixtures excluded: those are recorded data. */
function testFiles(dir = 'test'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/**
 * Defect 1: a shared user id between the tests and the scripts.
 *
 * withTestDb rolls back and `npm run trip` does not, so a reader's own live run
 * leaves a committed course.daily_usage row for the demo id that outlives every
 * test transaction for the rest of the UTC day. Tests that named that id read
 * spend they did not write, and the failure appeared only on machines where
 * somebody had actually run the thing the course tells them to run.
 *
 * This is not a test of behaviour, and that is deliberate: the defect is a habit,
 * so the guard has to be able to see the habit. A behavioural version would pass
 * on a clean database, which is exactly the condition under which the original
 * bug was invisible.
 */
describe('database tests are isolated from the scripts', () => {
  it('no test file hard-codes the id the scripts commit rows for', () => {
    const offenders = testFiles().filter((file) => readFileSync(file, 'utf8').includes(DEMO_USER))
    expect(offenders).toEqual([])
  })
})

/**
 * Defect 2: an idempotency key scoped to a conversation that does not exist yet.
 *
 * The key was unique on (conversation_id, idempotency_key). A first press has no
 * conversation, so fifty simultaneous first presses of one key each created
 * their own conversation, their own turn and their own message before anything
 * compared the keys. The existing fifty-press test did not catch it because it
 * pressed against a conversation that already existed, which is the one case the
 * broken scope handles correctly.
 *
 * This pins the RULE rather than that symptom: a migration that re-scoped the
 * key would fail here immediately, without needing anyone to think of writing
 * the concurrent first-press case a second time. A comment could have said the
 * same thing and been quietly wrong; a constraint read out of the catalogue
 * cannot be.
 */
describeDb('idempotency is keyed on the user, not the conversation', () => {
  it('says so in the database, where the rule actually lives', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ conname: string; def: string }[]>`
        select con.conname, pg_get_constraintdef(con.oid) as def
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace ns on ns.oid = rel.relnamespace
         where ns.nspname = 'course'
           and con.conname in ('turns_user_idempotency', 'messages_user_idempotency')
         order by con.conname`
      expect(rows.map((r) => r.conname)).toEqual(['messages_user_idempotency', 'turns_user_idempotency'])
      // Both, because busy and limit_reached open no turn at all, so the turns
      // constraint alone cannot recognise a retry of either.
      for (const row of rows) {
        expect(row.def).toBe('UNIQUE (user_id, idempotency_key)')
      }
    })
  })
})

const OUTAGE_USER = randomUUID()

const outageDeps = (sql: postgres.Sql, agent: Agent): WorkerDeps => ({
  sql, limits: DEFAULT_LIMITS, agent,
  now: () => Date.now(),
  deadlineMs: () => Date.now() + 600_000,
  reinvoke: async () => {},
  sleep: async () => {},
  random: () => 0,
})

/**
 * Defect 3: a driver throw that ends as silence.
 *
 * Module 2 caught the one error class it could name and parked the rest, because
 * a general answer needs somewhere for a failed turn to go. This is that answer:
 * whatever the driver throws, the turn ends, and it ends with a sentence in her
 * thread and a conversation she can type into again.
 *
 * A SpendUnconfirmedError thrown from inside the agent is the exact shape module
 * 2 described, and a plain Error is everything module 2's narrow catch
 * deliberately let through. Both must end the same way for her, and differently
 * on the row, which is what makes the reason worth recording at all.
 */
describeDb('a driver throw ends as something she can see', () => {
  it.each([
    ['a spend read that could not confirm', new SpendUnconfirmedError('cannot confirm'), 'unclassified'],
    ['a bug in our own code', new TypeError('x is not a function'), 'unclassified'],
  ])('%s', async (_name, thrown, reason) => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: OUTAGE_USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: randomUUID() },
      )
      const agent: Agent = async () => { throw thrown }
      await expect(runTurn(outageDeps(sql, agent), submitted.turnId!)).rejects.toThrow()

      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')          // not queued, and not running
      expect(t!.fail_reason).toBe(reason)

      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe(TURN_FAILED_MESSAGE)

      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('failed')          // off 'working', so the spinner stops

      // And the slot is free, which is the difference between a failure and a
      // dead conversation.
      const next = await submitMessage(
        { sql, limits: DEFAULT_LIMITS, invoke: async () => {} },
        { userId: OUTAGE_USER, conversationId: submitted.conversationId, message: 'try again',
          idempotencyKey: randomUUID() },
      )
      expect(next.status).toBe('queued')
    })
  })
})
