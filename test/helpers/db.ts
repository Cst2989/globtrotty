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
