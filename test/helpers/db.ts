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
        out = await fn(tx as unknown as postgres.Sql)
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
