import postgres from 'postgres'
import { describe } from 'vitest'

export const DB_URL = process.env.DATABASE_URL
export const describeDb = DB_URL ? describe : describe.skip

/** Runs fn inside a transaction that is always rolled back. */
export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL!, { max: 1, onnotice: () => {} })
  try {
    let out!: T
    await sql
      .begin(async (tx) => {
        // postgres.js only exposes `.savepoint` on a transaction-scoped `sql`, not
        // `.begin` — production code calls `sql.begin(...)` to wrap a group of writes
        // in a transaction, whether it's handed the root client or (as here, nested
        // inside this test's own rollback-only transaction) an already-open one. Shim
        // `.begin` onto the nested `tx` so those nested calls become savepoints.
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
