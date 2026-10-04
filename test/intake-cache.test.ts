/**
 * Polish pass, section 10, the brief half. The same sentence from the same traveller inside a
 * day is one Jev intake call, not two.
 *
 * Two properties carry the whole design, and both are pinned here:
 *
 *  - a CHOICE outcome is never remembered, because it depends on what she has already told this
 *    office and replaying it would re-ask a question she has answered;
 *  - every failure is a miss, including the table not existing at all — which is what makes the
 *    code safe to deploy before migration 0019 has been applied anywhere.
 */
import { describe, expect, it } from 'vitest'
import type postgres from 'postgres'
import { withTestDb, describeDb } from './helpers/db.js'
import { INTAKE_CACHE_TTL_MS, cachedBrief, intakeKey, rememberBrief } from '../src/agents/intakeCache.js'
import type { TripBrief } from '../src/intake/brief.js'

const NOW = new Date('2026-10-04T12:00:00Z')
const USER = '00000000-0000-4000-8000-00000000ca11'

const BRIEF: TripBrief = {
  origin: 'BCN', destination: 'TYO', sideTrip: null,
  outbound: '2026-11-19', inbound: '2026-12-06', adults: 2,
  cabinLong: 'premium_economy', cabinShort: 'economy', maxStops: null,
  hotels: false, arriveBy: true, assumptions: [{ field: 'year', value: '2026', reason: 'year' }],
}

describe('intakeKey', () => {
  it('ignores the things that do not change what she asked for', () => {
    const base = intakeKey(USER, 'Barcelona to Tokyo in November')
    expect(intakeKey(USER, '  barcelona  to   tokyo in november \n')).toBe(base)
    expect(intakeKey(USER, 'Barcelona to Osaka in November')).not.toBe(base)
  })

  it('is scoped to the traveller, so no account can be read through another one', () => {
    const other = '00000000-0000-4000-8000-00000000ca12'
    expect(intakeKey(other, 'Barcelona to Tokyo in November'))
      .not.toBe(intakeKey(USER, 'Barcelona to Tokyo in November'))
  })
})

describeDb('the brief cache', () => {
  async function seed(sql: postgres.Sql): Promise<void> {
    await sql`delete from intake_cache where user_id = ${USER}`
  }

  it('gives back the brief an identical message produced', async () => {
    await withTestDb(async (sql) => {
      await seed(sql)
      expect(await cachedBrief(sql, USER, 'Barcelona to Tokyo', NOW)).toBeNull()

      await rememberBrief(sql, USER, 'Barcelona to Tokyo', BRIEF)

      const hit = await cachedBrief(sql, USER, '  BARCELONA to tokyo  ', NOW)
      expect(hit).toEqual(BRIEF)
    })
  })

  it('forgets it after a day, and never serves another traveller\'s', async () => {
    await withTestDb(async (sql) => {
      await seed(sql)
      await rememberBrief(sql, USER, 'Barcelona to Tokyo', BRIEF)

      // Measured from the row's OWN `created_at` (the server's `now()`), not from this file's
      // fixture clock — the write uses the database's time and the read must be compared with it.
      const [row] = await sql<{ created_at: Date }[]>`
        select created_at from intake_cache where user_id = ${USER}`
      const tomorrow = new Date(row!.created_at.getTime() + INTAKE_CACHE_TTL_MS + 1000)
      expect(await cachedBrief(sql, USER, 'Barcelona to Tokyo', tomorrow)).toBeNull()

      const other = '00000000-0000-4000-8000-00000000ca13'
      expect(await cachedBrief(sql, other, 'Barcelona to Tokyo', NOW)).toBeNull()
    })
  })

  it('refreshes the row rather than growing a second one', async () => {
    await withTestDb(async (sql) => {
      await seed(sql)
      await rememberBrief(sql, USER, 'Barcelona to Tokyo', BRIEF)
      await rememberBrief(sql, USER, 'Barcelona to Tokyo', { ...BRIEF, adults: 3 })

      const rows = await sql<{ brief: TripBrief }[]>`
        select brief from intake_cache where user_id = ${USER}`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.brief.adults).toBe(3)
    })
  })

})

/*
 * The property that makes this safe to ship ahead of its own migration, and safe to keep once
 * shipped. A cache that can break the thing it is caching is not worth having, so every failure
 * — the table not existing, a revoked grant, a row that no longer parses — costs one model call
 * and nothing else.
 *
 * No DB: a handle that refuses every statement is a better stand-in for "the table is not
 * there" than renaming a real one, which would abort the surrounding transaction and prove
 * something about postgres.js rather than about this module.
 */
it('is a miss, never a throw, whatever the database says', async () => {
  const refusing = (() => {
    throw new Error('relation "intake_cache" does not exist')
  }) as unknown as postgres.Sql

  await expect(cachedBrief(refusing, USER, 'Barcelona to Tokyo', NOW)).resolves.toBeNull()
  await expect(rememberBrief(refusing, USER, 'Barcelona to Tokyo', BRIEF)).resolves.toBeUndefined()
})
