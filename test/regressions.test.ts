import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TURN_FAILED_MESSAGE } from '../src/failure-message.js'
import { submitMessage } from '../src/handler.js'
import { DEMO_SCRIPT_USER, DEMO_USER } from '../src/her.js'
import { SpendUnconfirmedError } from '../src/repo/spend.js'
import { runTurn, type Agent } from '../src/worker.js'
import { describeDb, withTestDb } from './helpers/db.js'
import { handlerDeps } from './helpers/turns.js'
import { workerDeps } from './helpers/worker.js'

// Resolved from this file rather than from process.cwd(): a guard that walks the
// test tree must find the same tree whoever invoked the suite and from wherever.
// A `root` in vitest.config.ts or a run started in a subdirectory would otherwise
// turn this test into an ENOENT rather than a result.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(TEST_DIR)
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url))

/**
 * Every test source file, as a path relative to the repo root. Fixtures are
 * excluded because those are recorded data, not code anyone reasons about.
 * `.mts` and `.cts` count: a helper in either extension carrying the id is the
 * same defect written in a different file suffix.
 */
function testFiles(dir = TEST_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(full)
    return /\.(ts|mts|cts)$/.test(entry.name) ? [path.relative(REPO_ROOT, full)] : []
  })
}

/** Both ids the scripts commit rows for, and the names they are exported under. */
const SCRIPT_IDS = [DEMO_USER, DEMO_SCRIPT_USER]
const SCRIPT_ID_NAMES = /\bDEMO_USER\b|\bDEMO_SCRIPT_USER\b/

/**
 * Defect 1: a shared user id between the tests and the scripts.
 *
 * withTestDb rolls back and `npm run trip` does not, so a reader's own live run
 * leaves a committed course.daily_usage row for the demo id that outlives every
 * test transaction for the rest of the UTC day. Tests that named that id read
 * spend they did not write, and the failure appeared only on machines where
 * somebody had actually run the thing the course tells them to run.
 *
 * Both script ids, not just `trip`'s. `npm run demo` deletes every row it wrote
 * at both ends of its run, so `DEMO_SCRIPT_USER` is usually invisible; a run
 * interrupted between those two cleanups (Ctrl-C, a closed terminal, a scenario
 * that threw) leaves its rows committed for the rest of the UTC day exactly like
 * `trip`'s, and its own daily_usage row with them.
 *
 * The names as well as the literals. `src/her.ts` advertises both ids as
 * exported constants, so the tidier spelling of this bug imports the constant
 * instead of retyping the UUID, and a guard that matched only the literal would
 * reward it. This file is the one exemption, because it has to import them to
 * do the check at all.
 *
 * This is not a test of behaviour, and that is deliberate: the defect is a habit,
 * so the guard has to be able to see the habit. A behavioural version would pass
 * on a clean database, which is exactly the condition under which the original
 * bug was invisible.
 */
describe('database tests are isolated from the scripts', () => {
  it('no test file names an id the scripts commit rows for', () => {
    const offenders = testFiles()
      .filter((file) => file !== SELF)
      .filter((file) => {
        const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
        return SCRIPT_IDS.some((id) => text.includes(id)) || SCRIPT_ID_NAMES.test(text)
      })
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
 *
 * The table is part of the rule. Constraint names are unique per table and not
 * per schema, so the query names both: without `rel.relname` a same-named
 * constraint on some third course table would satisfy this test by accident.
 */
describeDb('idempotency is keyed on the user, not the conversation', () => {
  it('says so in the database, where the rule actually lives', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ relname: string; conname: string; def: string }[]>`
        select rel.relname, con.conname, pg_get_constraintdef(con.oid) as def
          from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace ns on ns.oid = rel.relnamespace
         where ns.nspname = 'course'
           and rel.relname in ('turns', 'messages')
           and con.conname in ('turns_user_idempotency', 'messages_user_idempotency')
         order by con.conname`
      expect(rows.map((r) => `${r.relname}.${r.conname}`))
        .toEqual(['messages.messages_user_idempotency', 'turns.turns_user_idempotency'])
      // Both, because busy and limit_reached open no turn at all, so the turns
      // constraint alone cannot recognise a retry of either.
      for (const row of rows) {
        expect(row.def).toBe('UNIQUE (user_id, idempotency_key)')
      }
    })
  })
})

const OUTAGE_USER = randomUUID()

/**
 * Defect 3: a driver throw that ends as silence.
 *
 * Module 2 caught the one error class it could name and parked the rest, because
 * a general answer needs somewhere for a failed turn to go. This is that answer:
 * whatever the driver throws, the turn ends, and it ends with a sentence in her
 * thread and a conversation she can type into again.
 *
 * A SpendUnconfirmedError is the exact shape module 2 described, and it lands in
 * `unclassified` rather than a reason of its own. That is deliberate and not an
 * oversight: `classifyError` (src/errors.ts) recognises the provider's own error
 * classes, and an error raised by our own database read is not a provider
 * failure, so folding it into `provider_down` would put a fault of ours behind a
 * word that sends somebody to the provider's status page. It reads on the row
 * exactly like a TypeError of ours, because it IS one of ours; the rising count
 * of that bucket is the signal, and nothing here decomposes it.
 *
 * Thrown from inside the agent, which is a stand-in rather than the original
 * path: `readSpendOrLimitReached` (src/loop.ts) turns a SpendUnconfirmedError
 * raised by the loop's OWN ceiling read into 'limit_reached' before it can reach
 * runTurn's catch, so the fail-closed read module 2 wrote about can no longer
 * strand a turn. What this pins is the general case module 2 could not close:
 * a throw the harness has no name for still ends with something she can see.
 */
describeDb('a driver throw ends as something she can see', () => {
  it('fails the turn, tells her, and gives the slot back', async () => {
    await withTestDb(async (sql) => {
      const submitted = await submitMessage(
        handlerDeps(sql),
        { userId: OUTAGE_USER, conversationId: null, message: 'a week in Portugal', idempotencyKey: randomUUID() },
      )
      const agent: Agent = async () => { throw new SpendUnconfirmedError('cannot confirm') }
      await expect(runTurn(workerDeps(sql, agent), submitted.turnId!)).rejects.toThrow(SpendUnconfirmedError)

      const [t] = await sql`select status, fail_reason from course.turns where id = ${submitted.turnId}`
      expect(t!.status).toBe('failed')          // not queued, and not running
      expect(t!.fail_reason).toBe('unclassified')

      const msgs = await sql`select role, content from course.messages
                              where conversation_id = ${submitted.conversationId} order by seq`
      expect(msgs.map((m) => m.role)).toEqual(['user', 'agent'])
      expect(msgs[1]!.content).toBe(TURN_FAILED_MESSAGE)

      const [c] = await sql`select status from course.conversations where id = ${submitted.conversationId}`
      expect(c!.status).toBe('failed')          // off 'working', so the spinner stops

      // And the slot is free, which is the difference between a failure and a
      // dead conversation.
      const next = await submitMessage(
        handlerDeps(sql),
        { userId: OUTAGE_USER, conversationId: submitted.conversationId, message: 'try again',
          idempotencyKey: randomUUID() },
      )
      expect(next.status).toBe('queued')
    })
  })
})
