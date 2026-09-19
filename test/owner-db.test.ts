// Fix round 1 (plan 4a, Task 6 review, Important): `ownerSql()` is the one
// place the Next app is allowed to open a Postgres connection, reading only
// `DATABASE_URL` (never `loadEnv`, which would require
// `SUPABASE_SERVICE_ROLE_KEY` too — see the doc comment on `ownerSql`).
import { afterEach, describe, expect, it } from 'vitest'
import { ownerSql } from '../src/db/owner.js'

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL

afterEach(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
})

describe('ownerSql', () => {
  it('throws, naming DATABASE_URL, when it is unset', () => {
    delete process.env.DATABASE_URL
    expect(() => ownerSql()).toThrow(/DATABASE_URL/)
  })

  it('returns a client when DATABASE_URL is set, without connecting', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    // postgres.js connects lazily (on the first query) — constructing the
    // client here must not touch the network, so this asserts only on the
    // shape of what comes back, never issues a query.
    const sql = ownerSql()
    expect(typeof sql).toBe('function')
  })

  it('returns the same cached client across calls', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    expect(ownerSql()).toBe(ownerSql())
  })
})
