import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { describe } from 'vitest'
import { connect } from '../../src/db.js'

export const DB_URL = process.env.DATABASE_URL
/** Every test that needs Postgres is declared with this, so npm test works without one. */
export const describeDb = DB_URL ? describe : describe.skip

/** Runs fn inside a transaction that is always rolled back, so tests leave nothing behind. */
export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = connect(DB_URL!, 1)
  try {
    let out!: T
    await sql
      .begin(async (tx) => {
        // postgres.js only exposes `.savepoint` on a transaction-scoped `sql`, not
        // `.begin`. Production code calls `sql.begin(...)` to wrap a group of writes
        // in a transaction, whether it is handed the root client or, as here, an
        // already-open one. Shim `.begin` onto the nested `tx` so those nested calls
        // become savepoints.
        const nested = Object.assign(tx, {
          begin: <R>(cb: (sql: postgres.TransactionSql) => R | Promise<R>) => tx.savepoint(cb),
        }) as unknown as postgres.Sql
        out = await fn(nested)
        throw new Rollback()
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e
      })
    return out
  } finally {
    await sql.end({ timeout: 5 })
  }
}
class Rollback extends Error {}

/**
 * A real pool and a real commit, for the tests that are about concurrency. It
 * cannot roll back, so it invents a user id nobody else uses and deletes
 * everything belonging to it afterwards, children first.
 */
export async function withRealDb<T>(fn: (sql: postgres.Sql, userId: string) => Promise<T>): Promise<T> {
  const sql = connect(DB_URL!, 10)
  const userId = randomUUID()
  try {
    return await fn(sql, userId)
  } finally {
    await sql`delete from course.model_calls where user_id = ${userId}`
    await sql`delete from course.link_clicks where user_id = ${userId}`
    await sql`delete from course.proposals where user_id = ${userId}`
    await sql`delete from course.gate_results where user_id = ${userId}`
    await sql`delete from course.tool_results where user_id = ${userId}`
    // course.user_memory carries a user id, so it belongs here. course.source_memory
    // does NOT and is deliberately absent rather than forgotten: a fact about a
    // property belongs to nobody (migration 0016), so there is no user id this
    // function could delete it by. Nothing else deletes it either, and nothing
    // needs to yet: its only writer today is a case in test/memory.test.ts that
    // runs inside `withTestDb`, whose transaction is always rolled back, so its
    // rows never commit. The first writer that commits one is what has to give
    // this list a line, and it will need a key of its own to delete by.
    await sql`delete from course.user_memory where user_id = ${userId}`
    // Above the turns delete, because course.agent_events.turn_id is
    // `on delete set null` (migration 0017): a feed row would survive the turn
    // that wrote it and outlive the test that made it.
    await sql`delete from course.agent_events where user_id = ${userId}`
    await sql`delete from course.messages where user_id = ${userId}`
    await sql`delete from course.turns where user_id = ${userId}`
    await sql`delete from course.conversations where user_id = ${userId}`
    await sql`delete from course.daily_usage where user_id = ${userId}`
    await sql.end({ timeout: 5 })
  }
}
